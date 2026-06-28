import { resolveAgentAdapter } from '@excalibur/agent-runtime';
import {
  createReassessor,
  getGitInfo,
  getLocalDiff,
  interpretMission,
  MESH_LENSES,
  planStrategy,
  RunManager,
  runMission,
  runVerificationMesh,
  saveMission,
  scopeMapToMarkdown,
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
import { computeScope } from '../lib/scope';
import { shipChange } from '../lib/ship-pr';
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

/** Read-only capabilities run at a planner level (read tools only); the rest
 * mutate. `ship` is read-only too — its agentic turn only SUMMARIZES the change
 * for the PR; the deterministic ship step does the commit/push/PR. */
function capabilityLevel(capability: string, sessionLevel: AutonomyLevel): AutonomyLevel {
  const readOnly = ['understand', 'plan', 'discover', 'verify', 'review', 'ship'];
  return (readOnly.includes(capability) ? 1 : Math.max(2, sessionLevel)) as AutonomyLevel;
}

/**
 * The task prompt handed to the agentic turn for a capability step. When an
 * earlier `understand` step produced a scope map (AO9), it is threaded into every
 * LATER step so plan/implement/verify build ON the established understanding
 * instead of re-discovering the codebase from scratch.
 */
export function capabilityTask(
  step: PlanStep,
  mission: Mission,
  context: { understanding?: string } = {},
): string {
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
  const base = `${framing[step.capability] ?? 'Do the objective.'}\n\nObjective: ${step.objective}\nOverall goal: ${mission.goal}`;
  // Feed the understand step's scope map forward (not into understand itself).
  if (
    step.capability !== 'understand' &&
    context.understanding !== undefined &&
    context.understanding.length > 0
  ) {
    return `${base}\n\nWhat an earlier read-only scope already established about this codebase — build ON it, do not re-discover:\n${context.understanding.slice(0, 4000)}`;
  }
  return base;
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
  /**
   * Cancels the WHOLE mission when the user presses ESC during any step's live
   * view (the step's ESC aborts only that step otherwise). The caller wires it to
   * the mission controller's `.abort()` so ESC and Ctrl-C cancel identically.
   */
  onEscape?: () => void;
  /** Hard budget ceiling in cents — the mission PAUSES when reached (resumable). */
  budgetCents?: number;
  /**
   * Open a real pull request at the `ship` step (M8 follow-up): branch off the
   * default, commit, push, and `gh pr create`. Opt-in — pushing to a remote is
   * outward-facing, so it is OFF unless the user asked for it (`mission --pr`).
   * Without it (or without `gh`/a remote) `ship` just commits locally.
   */
  openPr?: boolean;
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
  deps.ui.info(deps.t('mission.interpreting'));
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

  // 2) The capability executor — each step is a REAL agentic turn, rendered with
  // the mission plan ribbon pinned above its rail (M8 #43).
  const isTty = deps.ui.isOutputTty();
  const baseTurn = (level: AutonomyLevel, ribbonModel: MissionRibbonModel): AgentTurnDeps => ({
    deps,
    repoRoot,
    config: opts.config,
    gateway: gateway.gateway,
    providerName: gateway.providerName,
    autonomyLevel: level,
    approvals: opts.approvals,
    signal,
    // ESC in any step's live view cancels the WHOLE mission, not just that step.
    ...(opts.onEscape !== undefined ? { onEscape: opts.onEscape } : {}),
    adapter,
    ribbon: ribbonModel,
  });
  // AO9 — the understand step's scope map, threaded into every later step so the
  // mission builds ON the established understanding (set by the `understand`
  // special-case below; empty until then).
  let understanding = '';
  /** The step prompt, grounded in the accumulated understanding. */
  const taskFor = (step: PlanStep): string => capabilityTask(step, mission, { understanding });

  const executor: CapabilityExecutor = async (step, state) => {
    const level = capabilityLevel(step.capability, opts.autonomyLevel);
    const turn = baseTurn(level, toRibbon(state));
    // A blank line before each step's header so the steps breathe apart instead of
    // stacking line-on-line (RUN-FIX-14).
    deps.ui.write();
    deps.ui.write(pc.cyan(`▶ ${step.capability}: ${step.objective}`));

    // `understand` uses the REAL AO9 scope engine: decompose the objective, fan
    // out parallel READ-ONLY explorers, and synthesize a ScopeMap (subsystems ·
    // built-vs-missing · risks) — the proactive "understand-first" map that then
    // grounds every later step. Degrades to a generic read-only turn on failure.
    if (step.capability === 'understand') {
      try {
        const map = await computeScope(repoRoot, taskFor(step), gateway, { signal });
        if (map !== null) {
          understanding = scopeMapToMarkdown(map);
          deps.ui.write(pc.dim(`  ${map.summary}`));
          for (const s of map.subsystems.slice(0, 8)) {
            const gap = s.whatsMissing.trim().length > 0 ? ` — ${s.whatsMissing}` : '';
            deps.ui.write(pc.dim(`  • ${s.subsystem}${gap}`));
          }
          return {
            ok: true,
            summary: map.summary.slice(0, 600),
            signals: {
              engine: 'scope',
              subsystems: map.subsystems.length,
              risks: map.risks.length,
              openQuestions: map.openQuestions.length,
            },
          };
        }
      } catch {
        /* fall through to a generic read-only understand turn */
      }
    } else if (step.capability === 'parallelize') {
      // `parallelize` and `explore` use their REAL dedicated engines (the swarm /
      // best-of-N) when the step calls for them; on a setup failure (e.g. not a git
      // repo) they degrade to a single agentic run. The subsequent test/verify gates
      // ground overall correctness via runVerdict.
      try {
        await runSwarmFlow(
          deps,
          repoRoot,
          taskFor(step),
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
          taskFor(step),
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
      // A real "ship": let the agentic turn WRITE the PR summary (read-only), then
      // commit — and, when the user opted in (`--pr`) and a gh remote is reachable,
      // branch + push + open the PR. Nothing changed → a no-op, still ok.
      if (getLocalDiff(repoRoot).trim().length === 0) {
        return {
          ok: true,
          summary: 'Nothing to ship.',
          signals: { engine: 'ship', committed: false },
        };
      }
      let body = '';
      try {
        const summary = await runAgentTurn(turn, taskFor(step));
        body = summary.text;
      } catch {
        /* the PR body is best-effort — fall back to the goal as the title/body */
      }
      const result = shipChange(repoRoot, {
        goal: mission.goal,
        body,
        openPr: opts.openPr === true,
        gitInfo: getGitInfo(repoRoot),
      });
      deps.ui.write(
        result.prUrl !== undefined ? pc.green(`  ⇪ ${result.note}`) : pc.dim(`  ⇪ ${result.note}`),
      );
      return {
        ok: true,
        summary: result.note,
        signals: {
          engine: result.prUrl !== undefined ? 'pr' : 'commit',
          committed: result.committed,
          ...(result.branch !== undefined ? { branch: result.branch } : {}),
          ...(result.prUrl !== undefined ? { prUrl: result.prUrl } : {}),
        },
      };
    }

    try {
      const result = await runAgentTurn(turn, taskFor(step));
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
      // On a TTY the ribbon is pinned above each capability's rail (via the turn's
      // `ribbon`); on a pipe/CI, print it as a text header before each step.
      if (event.kind === 'step_started' && !isTty) ribbon(s);
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
