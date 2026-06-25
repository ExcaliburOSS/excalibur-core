import { resolveAgentAdapter } from '@excalibur/agent-runtime';
import {
  commitAll,
  createReassessor,
  getLocalDiff,
  interpretMission,
  MESH_LENSES,
  planStrategy,
  RunManager,
  runMission,
  runVerificationMesh,
  saveMission,
  type CapabilityExecutor,
  type Mission,
  type MissionState,
  type PlanStep,
} from '@excalibur/core';
import { generateId, type AutonomyLevel, type ExcaliburConfig } from '@excalibur/shared';
import {
  detectColorTier,
  detectThemeSync,
  renderRibbon,
  type MissionRibbonModel,
} from '@excalibur/tui';
import pc from 'picocolors';
import type { CliDeps } from '../deps';
import { loadGatewayContext, requireConfiguredModel } from '../lib/context';
import { runExploreFlow } from '../lib/explore';
import { captureRestorePoint, printRecoveryHint, warnDirtyTree } from '../lib/run-safety';
import { runSwarmFlow } from '../lib/swarm';
import { runAgentTurn, type AgentTurnDeps, type ApprovalState } from './agent-turn';

/**
 * M8 — the meta-orchestrator's REAL wiring. `runMissionTurn` ties the planning
 * brain (M1–M3) and the adaptive supervisor (M4–M5) to the proven run engine:
 * it interprets the goal, auto-authors the capability DAG, then drives it — each
 * capability runs as a REAL agentic turn ({@link runAgentTurn}: the native tool
 * loop with permissions, the safety floor, and conversational narration). The
 * plan ribbon shows progress, the model adapts after gates/failures, and the
 * mission is checkpointed so a long job is resumable.
 */

/** Read-only capabilities run at a planner level (read tools only); the rest mutate. */
function capabilityLevel(capability: string, sessionLevel: AutonomyLevel): AutonomyLevel {
  const readOnly = ['understand', 'plan', 'discover', 'verify', 'review'];
  return (readOnly.includes(capability) ? 1 : Math.max(2, sessionLevel)) as AutonomyLevel;
}

/** The task prompt handed to the agentic turn for a capability step. */
function capabilityTask(step: PlanStep, mission: Mission): string {
  const framing: Record<string, string> = {
    understand:
      'Explore the codebase READ-ONLY and map what is relevant to the objective. Report your findings concisely — do not modify anything.',
    discover:
      'Clarify the requirements for the objective. If something is genuinely ambiguous, state the options and your recommended assumption; do not modify files.',
    plan: 'Produce a concrete, step-by-step implementation plan for the objective. Do NOT modify files.',
    implement: 'Implement the objective. Make the change and keep the project building.',
    parallelize:
      'Implement the objective. It splits into independent parts — do them all and integrate.',
    explore:
      'Implement the objective. Consider a couple of approaches, pick the best, and apply it.',
    test: 'Run the project test suite for the objective and report clearly whether it PASSED or FAILED (with the failing cases).',
    verify:
      'Critically VERIFY the recent change for the objective is correct and complete. Actively hunt for what is wrong; report issues, or state explicitly that it holds.',
    review:
      'Review the recent change for the objective (correctness, regressions, quality). Report findings.',
    ship: 'Summarize the completed change for a pull request (title + body). Do NOT push or open the PR.',
  };
  return `${framing[step.capability] ?? 'Do the objective.'}\n\nObjective: ${step.objective}\nOverall goal: ${mission.goal}`;
}

/**
 * A GROUND-TRUTH verdict for a capability's run, read from its persisted events —
 * so a gate (test/verify) is judged on real signals, not only the model's prose.
 * `ok` is false on a hard failure signal (a graceful `error`, a failed
 * `test_result`, a refuted `claim`, a blocked `verification`); the structured
 * signals are also fed to the reassessor. Absent signals → ok (the model judges).
 */
export function runVerdict(
  repoRoot: string,
  runId: string,
): { ok: boolean; signals: Record<string, unknown> } {
  let events;
  try {
    events = new RunManager(repoRoot).readEvents(runId);
  } catch {
    return { ok: true, signals: {} };
  }
  let testsPassed: boolean | undefined;
  let hardFail = false;
  let errorCount = 0;
  const exitCodes: number[] = [];
  for (const e of events) {
    const p = e.payload;
    if (e.type === 'error') {
      hardFail = true;
      errorCount += 1;
    } else if (e.type === 'test_result') {
      const s = String(p['status'] ?? '');
      testsPassed = s === 'passed' || s === 'green' || s === 'ok';
      if (!testsPassed) hardFail = true;
    } else if (e.type === 'claim' && p['status'] === 'refuted') {
      hardFail = true;
    } else if (e.type === 'verification' && p['blocked'] === true) {
      hardFail = true;
    } else if (e.type === 'command_completed' && typeof p['exitCode'] === 'number') {
      exitCodes.push(p['exitCode'] as number);
    }
  }
  const signals: Record<string, unknown> = {
    ...(testsPassed !== undefined ? { testsPassed } : {}),
    ...(errorCount > 0 ? { errorCount } : {}),
    ...(exitCodes.length > 0 ? { exitCodes } : {}),
  };
  return { ok: !hardFail, signals };
}

/** Projects the live supervisor state into the ribbon view-model. */
function toRibbon(state: MissionState): MissionRibbonModel {
  return {
    goal: state.mission.goal,
    spentCents: state.spentCents,
    criteriaTotal: state.mission.successCriteria.length,
    outcome: state.outcome,
    steps: state.steps.map((s) => ({
      id: s.step.id,
      capability: s.step.capability,
      objective: s.step.objective,
      status: s.status,
      gate: s.step.gate,
      attempts: s.attempts,
    })),
  };
}

export interface MissionRunOptions {
  deps: CliDeps;
  repoRoot: string;
  config: ExcaliburConfig;
  autonomyLevel: AutonomyLevel;
  approvals: ApprovalState;
  signal: AbortSignal;
  /** Hard budget ceiling in cents — the mission PAUSES when reached (resumable). */
  budgetCents?: number;
}

/**
 * Runs a full mission from a natural-language goal: interpret → plan → drive the
 * capability DAG adaptively against the real run engine. Returns the final
 * (checkpointed) {@link MissionState}. Never throws — surfaces failures as the
 * mission outcome.
 */
export async function runMissionTurn(goal: string, opts: MissionRunOptions): Promise<MissionState> {
  const { deps, repoRoot, signal } = opts;
  const gateway = loadGatewayContext(repoRoot);
  requireConfiguredModel(gateway, deps.t);
  const adapter = resolveAgentAdapter(opts.config);
  // Interpretation + planning use the FAST cheap model (low latency); execution
  // uses the session's default provider.
  const planProvider = gateway.cheapProviderName ?? gateway.providerName;
  const tier = detectColorTier();
  const mode = detectThemeSync() ?? 'dark';
  const ribbon = (state: MissionState): void => {
    for (const line of renderRibbon(toRibbon(state), { tier, mode })) deps.ui.write(line);
  };

  // A mission runs autonomously and mutates the real tree — make it recoverable:
  // nudge to a clean start and snapshot the pre-run state so a failure can roll back.
  warnDirtyTree(deps, repoRoot);
  const restorePoint = captureRestorePoint(repoRoot);

  // 1) Interpret the need + auto-author the strategy (the brain).
  deps.ui.info('Interpreting your goal and planning the strategy…');
  const mission = await interpretMission(goal, {
    gateway: gateway.gateway,
    ...(planProvider !== null ? { provider: planProvider } : {}),
    signal,
  });
  const plan = await planStrategy(mission, {
    gateway: gateway.gateway,
    ...(planProvider !== null ? { provider: planProvider } : {}),
    signal,
  });
  deps.ui.write(pc.dim(plan.rationale));

  // 2) The capability executor — each step is a REAL agentic turn.
  const baseTurn = (level: AutonomyLevel): AgentTurnDeps => ({
    deps,
    repoRoot,
    config: opts.config,
    gateway: gateway.gateway,
    providerName: gateway.providerName,
    autonomyLevel: level,
    approvals: opts.approvals,
    signal,
    adapter,
  });
  const executor: CapabilityExecutor = async (step) => {
    const level = capabilityLevel(step.capability, opts.autonomyLevel);
    deps.ui.write(pc.cyan(`▶ ${step.capability}: ${step.objective}`));

    // `parallelize` and `explore` use their REAL dedicated engines (the swarm /
    // best-of-N) when the step calls for them; on a setup failure (e.g. not a git
    // repo) they degrade to a single capable run. The subsequent test/verify gates
    // ground overall correctness via runVerdict.
    if (step.capability === 'parallelize') {
      try {
        await runSwarmFlow(
          deps,
          repoRoot,
          capabilityTask(step, mission),
          { gateway: gateway.gateway, providerName: gateway.providerName, config: opts.config },
          { yes: true, apply: true, grade: true, signal },
        );
        return {
          ok: true,
          summary: `Ran a parallel swarm for: ${step.objective}`,
          signals: { engine: 'swarm' },
        };
      } catch {
        /* fall through to a single agentic run */
      }
    } else if (step.capability === 'explore') {
      try {
        await runExploreFlow(
          deps,
          repoRoot,
          capabilityTask(step, mission),
          { gateway: gateway.gateway, providerName: gateway.providerName, config: opts.config },
          { yes: true, signal },
        );
        return {
          ok: true,
          summary: `Explored several approaches and applied the best for: ${step.objective}`,
          signals: { engine: 'explore' },
        };
      } catch {
        /* fall through to a single agentic run */
      }
    } else if (step.capability === 'verify') {
      // The real adversarial gate: the verification mesh refutes the change across
      // lenses. A surviving HIGH issue BLOCKS → ok=false (the supervisor reassesses).
      const diff = getLocalDiff(repoRoot);
      if (diff.trim().length > 0) {
        try {
          const result = await runVerificationMesh({
            diff,
            lenses: Object.keys(MESH_LENSES) as (keyof typeof MESH_LENSES)[],
            gateway: gateway.gateway,
            ...(planProvider !== null ? { provider: planProvider } : {}),
            signal,
          });
          deps.ui.write(
            result.blocked ? pc.red(`  ⚖ ${result.summary}`) : pc.green(`  ⚖ ${result.summary}`),
          );
          return {
            ok: !result.blocked,
            summary: result.summary,
            signals: { engine: 'mesh', blocked: result.blocked, issues: result.issues.length },
          };
        } catch {
          /* fall through to a single agentic verify run */
        }
      }
    } else if (step.capability === 'ship') {
      // A real local "ship": commit the work (PR creation needs a gh remote — a
      // further follow-up). Nothing changed → a no-op, still ok.
      if (getLocalDiff(repoRoot).trim().length > 0) {
        const committed = commitAll(repoRoot, `Excalibur: ${mission.goal.slice(0, 72)}`);
        return {
          ok: true,
          summary: committed ? 'Committed the change.' : 'Nothing to commit.',
          signals: { engine: 'commit', committed },
        };
      }
      return {
        ok: true,
        summary: 'Nothing to commit.',
        signals: { engine: 'commit', committed: false },
      };
    }

    try {
      const result = await runAgentTurn(baseTurn(level), capabilityTask(step, mission));
      // Ground the outcome in the run's real events (failed tests / refuted claims /
      // errors) so gates aren't judged on the model's prose alone; the reassessor
      // also sees the structured signals.
      const verdict = runVerdict(repoRoot, result.runId);
      return {
        ok: verdict.ok,
        summary: result.text.slice(0, 600),
        signals: {
          costCents: result.costCents ?? 0,
          runId: result.runId,
          mutated: result.mutated,
          ...verdict.signals,
        },
      };
    } catch (error) {
      return { ok: false, summary: error instanceof Error ? error.message : String(error) };
    }
  };

  // 3) Drive the DAG, adapting after each gate/failure; checkpoint every step.
  const missionId = generateId('mission');
  const state = await runMission(mission, plan, {
    id: missionId,
    executor,
    reassess: createReassessor({
      gateway: gateway.gateway,
      ...(planProvider !== null ? { provider: planProvider } : {}),
    }),
    onEvent: (event, s) => {
      saveMission(repoRoot, s);
      if (event.kind === 'step_started') ribbon(s);
      if (
        event.kind === 'replan' ||
        event.kind === 'step_escalated' ||
        event.kind === 'step_retry'
      ) {
        deps.ui.write(pc.yellow(`  ↻ ${event.message}`));
      }
    },
    signal,
    ...(opts.budgetCents !== undefined ? { budgetCents: opts.budgetCents } : {}),
  });

  // 4) Final ribbon + outcome.
  ribbon(state);
  const label =
    state.outcome === 'completed'
      ? pc.green('✓ Mission complete.')
      : state.outcome === 'paused'
        ? pc.yellow(`⏸ Mission paused: ${state.pausedReason ?? ''} — resume to continue.`)
        : pc.red(`Mission ended: ${state.outcome}.`);
  deps.ui.write(label);
  // On anything but a clean completion, show how to roll the mutations back.
  if (state.outcome !== 'completed') {
    printRecoveryHint(deps, restorePoint);
  }
  return state;
}
