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
  type OrchestrationPlan,
  type PlanStep,
  type PlanStepStatus,
  type StepResult,
  type StepStatus,
} from '@excalibur/core';
import {
  createEvent,
  generateId,
  type AutonomyLevel,
  type ExcaliburConfig,
} from '@excalibur/shared';
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
import { mountConversationalRail, type ConversationalRail } from '../lib/run-pipeline';
import {
  materializeAutoBuild,
  markAutoBuildStep,
  settleAutoBuild,
  type AutoBuildBoard,
} from '../lib/auto-build-board';
import { showResult } from '../lib/show-result';
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
   * The live companion dashboard URL (`runtime.dashboardUrl`), so a mission — like every other
   * build path — materializes its capability DAG into work items (epic = the goal, each step a
   * sub-task) and surfaces a deep link the user can watch fill in. Null → no dashboard running.
   */
  dashboardUrl?: string | null;
  /**
   * Cancels the WHOLE mission when the user presses ESC during any step's live
   * view (the step's ESC aborts only that step otherwise). The caller wires it to
   * the mission controller's `.abort()` so ESC and Ctrl-C cancel identically.
   */
  onEscape?: () => void;
  /**
   * Typing-during-execution (RUN-FIX-16): forwarded to each capability step's turn
   * so the user can TYPE while a mission runs — the message is triaged (steer/quick/
   * independent/stop) by the shell's INT-1 brain without losing the work.
   */
  onInterrupt?: AgentTurnDeps['onInterrupt'];
  /** Hard budget ceiling in cents — the mission PAUSES when reached (resumable). */
  budgetCents?: number;
  /**
   * G3 — RESUME a checkpointed mission (paused on a budget/time ceiling, or
   * interrupted by a crash/close) instead of interpreting + planning a fresh one.
   * The saved {@link MissionState} carries the mission DAG and per-step progress,
   * so the drive picks up at the first unfinished step, unattended.
   */
  resume?: MissionState;
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

  // 1) RESUME a checkpointed mission (G3) — reuse its saved DAG + progress, no
  // re-interpretation (which could drift). Otherwise interpret the need + auto-
  // author the strategy (the brain).
  let mission: Mission;
  let plan: OrchestrationPlan;
  if (opts.resume !== undefined) {
    mission = opts.resume.mission;
    plan = {
      goal: opts.resume.mission.goal,
      steps: opts.resume.steps.map((s) => s.step),
      rationale: '',
    };
    deps.ui.info(deps.t('mission.resuming', { goal: opts.resume.mission.goal }));
  } else {
    deps.ui.info(deps.t('mission.interpreting'));
    mission = await interpretMission(goal, {
      gateway: gateway.gateway,
      ...(planProvider !== null ? { provider: planProvider } : {}),
      signal,
    });
    plan = await planStrategy(mission, {
      gateway: gateway.gateway,
      ...(planProvider !== null ? { provider: planProvider } : {}),
      signal,
    });
    deps.ui.write(pc.dim(plan.rationale));
  }

  // 1b) MATERIALIZE the mission's capability DAG into the board — like EVERY other build path
  // (edit / plan / swarm / auto-build) — so the work shows up as an EPIC + one work item per
  // capability step, live-synced and DEEP-LINKED into the dashboard the user can watch fill in.
  // This closed the gap where a mission left no work items and no dashboard link (its `ship`
  // step commits, so the universal safety-net saw a clean tree and skipped it). Best-effort — a
  // board fault never gates the mission — and announced BEFORE the rail mounts so the stdout
  // writes never corrupt the Ink frame.
  const MISSION_TO_BOARD_STATUS: Record<StepStatus, PlanStepStatus> = {
    pending: 'pending',
    running: 'active',
    done: 'done',
    failed: 'blocked',
    skipped: 'skipped',
  };
  let board: AutoBuildBoard | null = null;
  if (getGitInfo(repoRoot).isRepo) {
    try {
      const b = materializeAutoBuild(
        repoRoot,
        mission.goal,
        plan.steps.map((s) => ({
          id: s.id,
          title: `${s.capability}: ${s.objective}`,
          instruction: s.objective,
          ...(s.dependsOn.length > 0 ? { dependsOn: s.dependsOn } : {}),
        })),
        { planRunId: generateId('turn') },
      );
      board = b;
      if (b !== null && b.epicWorkItemId !== null) {
        const sprint =
          b.sprintId != null ? deps.t('repl.auto-build-board-sprint', { sprint: b.sprintId }) : '';
        deps.ui.info(
          deps.t('repl.auto-build-board-epic', {
            epic: b.epicWorkItemId,
            count: b.stepBySubtask.size,
            sprint,
          }),
        );
        if (opts.dashboardUrl != null) {
          deps.ui.info(
            deps.t('dashboard.up', { url: `${opts.dashboardUrl}#/work-items/${b.epicWorkItemId}` }),
          );
        }
      }
    } catch {
      board = null; // the board is additive — never gate the mission on it
    }
  }

  // 2) The capability executor. The WHOLE mission renders into ONE persistent rail
  // (RUN-FIX-23): the input box stays put and there is constant motion across every step,
  // instead of each step mounting + tearing down its own rail (which duplicated the ribbon in
  // scrollback, flickered, and made the input box vanish between steps). The rail is closed
  // ONLY around steps that mount their OWN Ink view (the swarm's Lanes / best-of-N) — two Ink
  // live regions can't share the screen — then reopened for the next step.
  const isTty = deps.ui.isOutputTty();
  const mountMissionRail = (): Promise<ConversationalRail | null> =>
    mountConversationalRail(deps, {
      currentWork: mission.goal,
      autonomyLevel: opts.autonomyLevel,
      onAbort: () => opts.onEscape?.(),
      ...(opts.onInterrupt !== undefined ? { onInterrupt: opts.onInterrupt } : {}),
    });
  let rail: ConversationalRail | null = isTty ? await mountMissionRail() : null;
  /** Keep the persistent rail OPEN (agentic/deterministic steps) or CLOSED (steps that mount
   * their own Ink view). Idempotent. */
  const ensureRail = async (wantOpen: boolean): Promise<void> => {
    if (wantOpen && rail === null && isTty) {
      rail = await mountMissionRail();
    } else if (!wantOpen && rail !== null) {
      await rail.close();
      rail = null;
    }
  };

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
    // Typing-during-execution: the persistent rail arms the interrupt channel (RUN-FIX-16).
    ...(opts.onInterrupt !== undefined ? { onInterrupt: opts.onInterrupt } : {}),
    // Render into the ONE persistent mission rail instead of a per-step rail; undefined off a
    // TTY (or during a swarm step, when runAgentTurn mounts its own for a fall-through).
    ...(rail !== null ? { view: rail.view } : {}),
    adapter,
    ribbon: ribbonModel,
  });
  // AO9 — the understand step's scope map, threaded into every later step so the
  // mission builds ON the established understanding (set by the `understand`
  // special-case below; empty until then).
  let understanding = '';
  /** The step prompt, grounded in the accumulated understanding. */
  const taskFor = (step: PlanStep): string => capabilityTask(step, mission, { understanding });

  /** Render a DETERMINISTIC engine step (understand/verify — no agentic loop) as a LIVE phase
   * in the persistent rail: a pulsing header while the engine runs, then its result committed
   * as a narration line. Motion + input box preserved, and NO raw stdout write to corrupt the
   * Ink frame. Off a TTY (rail === null) it degrades to the old plain header + dim lines. `run`
   * returns null to DECLINE (the caller falls through to a generic agentic turn). */
  const runInRailPhase = async (
    capability: string,
    objective: string,
    run: () => Promise<{ lines: string[]; result: StepResult } | null>,
  ): Promise<StepResult | null> => {
    if (rail === null) {
      deps.ui.write();
      deps.ui.write(pc.cyan(`▶ ${capability}: ${objective}`));
      const out = await run();
      if (out === null) return null;
      for (const line of out.lines) deps.ui.write(pc.dim(`  ${line}`));
      return out.result;
    }
    const phaseId = `mission-${capability}`;
    const title = capability.charAt(0).toUpperCase() + capability.slice(1);
    const view = rail.view;
    view.push(
      createEvent({
        runId: null,
        type: 'phase_started',
        payload: { name: title, detail: objective },
        phaseId,
      }),
    );
    let out: { lines: string[]; result: StepResult } | null = null;
    try {
      out = await run();
    } finally {
      if (out !== null && out.lines.length > 0) {
        view.push(
          createEvent({
            runId: null,
            type: 'model_call',
            payload: { content: out.lines.join('\n') },
            phaseId,
          }),
        );
      }
      // Always close the synthetic node so it never spins forever.
      view.push(createEvent({ runId: null, type: 'phase_completed', payload: {}, phaseId }));
    }
    return out?.result ?? null;
  };

  const executor: CapabilityExecutor = async (step, state) => {
    const level = capabilityLevel(step.capability, opts.autonomyLevel);
    const ribbonModel = toRibbon(state);
    // Light this step's work item up as ACTIVE on the board (live dashboard sync).
    if (board !== null) {
      try {
        markAutoBuildStep(repoRoot, board, step.id, 'active');
      } catch {
        /* board sync is best-effort */
      }
    }
    // Steps that mount their OWN Ink view (swarm Lanes / best-of-N) need the mission rail
    // CLOSED; every other step keeps it OPEN (persistent input box + motion). Then start a
    // fresh live section for this step (the committed scrollback GROWS — RunView accumulator)
    // and pin the updated ribbon.
    const ownsView = step.capability === 'parallelize' || step.capability === 'explore';
    await ensureRail(!ownsView);
    if (rail !== null) {
      rail.view.resetEvents();
      rail.view.setRibbon(ribbonModel);
    } else if (!ownsView) {
      // Non-TTY fallback header for an agentic step (the rail-phase helper prints its own).
      deps.ui.write();
      deps.ui.write(pc.cyan(`▶ ${step.capability}: ${step.objective}`));
    }
    const turn = baseTurn(level, ribbonModel);

    // `understand` uses the REAL AO9 scope engine: decompose the objective, fan
    // out parallel READ-ONLY explorers, and synthesize a ScopeMap (subsystems ·
    // built-vs-missing · risks) — the proactive "understand-first" map that then
    // grounds every later step. Degrades to a generic read-only turn on failure.
    if (step.capability === 'understand') {
      const outcome = await runInRailPhase('understand', step.objective, async () => {
        try {
          const map = await computeScope(repoRoot, taskFor(step), gateway, { signal });
          if (map === null) return null;
          understanding = scopeMapToMarkdown(map);
          const lines = [map.summary];
          for (const s of map.subsystems.slice(0, 8)) {
            const gap = s.whatsMissing.trim().length > 0 ? ` — ${s.whatsMissing}` : '';
            lines.push(`• ${s.subsystem}${gap}`);
          }
          return {
            lines,
            result: {
              ok: true,
              summary: map.summary.slice(0, 600),
              signals: {
                engine: 'scope',
                subsystems: map.subsystems.length,
                risks: map.risks.length,
                openQuestions: map.openQuestions.length,
              },
            },
          };
        } catch {
          return null; // fall through to a generic read-only understand turn
        }
      });
      if (outcome !== null) return outcome;
    } else if (step.capability === 'parallelize') {
      // `parallelize` and `explore` use their REAL dedicated engines (the swarm /
      // best-of-N). The mission rail is already CLOSED (ensureRail above) so their own
      // Ink view owns the screen. On a setup failure they degrade to a single agentic run.
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
        /* fall through to a single agentic run (runAgentTurn mounts its own rail) */
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
        const outcome = await runInRailPhase('verify', step.objective, async () => {
          try {
            const result = await runVerificationMesh({
              diff,
              lenses: Object.keys(MESH_LENSES) as (keyof typeof MESH_LENSES)[],
              gateway: gateway.gateway,
              ...(planProvider !== null ? { provider: planProvider } : {}),
              signal,
            });
            return {
              lines: [`⚖ ${result.summary}`],
              result: {
                ok: !result.blocked,
                summary: result.summary,
                signals: { engine: 'mesh', blocked: result.blocked, issues: result.issues.length },
              },
            };
          } catch {
            return null; // fall through to a single agentic verify run
          }
        });
        if (outcome !== null) return outcome;
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
      // Route the ship note through the rail (a raw stdout write corrupts the live frame).
      const shipNote = `⇪ ${result.note}`;
      if (rail !== null) rail.notice(shipNote);
      else
        deps.ui.write(
          result.prUrl !== undefined ? pc.green(`  ${shipNote}`) : pc.dim(`  ${shipNote}`),
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
  // On resume, keep the SAME id so checkpoints continue in the same dir and
  // runMission bootstraps from the saved state (skips the fresh init).
  const missionId = opts.resume?.id ?? generateId('mission');
  let state: MissionState;
  try {
    state = await runMission(mission, plan, {
      ...(opts.resume !== undefined ? { resumeFrom: opts.resume } : {}),
      id: missionId,
      executor,
      reassess: createReassessor({
        gateway: gateway.gateway,
        ...(planProvider !== null ? { provider: planProvider } : {}),
      }),
      onEvent: (event, s) => {
        saveMission(repoRoot, s);
        // On a TTY the ribbon is pinned above the persistent rail (setRibbon per step); on a
        // pipe/CI, print it as a text header before each step.
        if (event.kind === 'step_started' && !isTty) ribbon(s);
        if (
          event.kind === 'replan' ||
          event.kind === 'step_escalated' ||
          event.kind === 'step_retry'
        ) {
          // Route through the rail — a raw stdout write while Ink owns the screen corrupts it.
          if (rail !== null) rail.notice(`↻ ${event.message}`);
          else deps.ui.write(pc.yellow(`  ↻ ${event.message}`));
        }
      },
      signal,
      ...(opts.budgetCents !== undefined ? { budgetCents: opts.budgetCents } : {}),
    });
  } catch (err) {
    // Never leak the rail (and stdin) if the drive throws unexpectedly.
    if (rail !== null) {
      try {
        await rail.close();
      } catch {
        /* best-effort */
      }
      rail = null;
    }
    throw err;
  }

  // 4) Close the persistent rail, then the final outcome. On a TTY the rail's pinned ribbon
  // (set to the FINAL state here) commits to scrollback on close — so we do NOT also print the
  // static ribbon (that was the duplication). Off a TTY, print it as text.
  if (rail !== null) {
    rail.view.setRibbon(toRibbon(state));
    await rail.close();
    rail = null;
  } else {
    ribbon(state);
  }
  // SETTLE the board to the mission's final per-step outcome (done / blocked / skipped), so the
  // dashboard work items reflect what actually happened — the money+status side of the mission.
  if (board !== null) {
    try {
      const statusBySubtask = new Map<string, PlanStepStatus>();
      for (const st of state.steps) {
        statusBySubtask.set(st.step.id, MISSION_TO_BOARD_STATUS[st.status]);
      }
      settleAutoBuild(repoRoot, board, mission.goal, { statusBySubtask, fallback: 'pending' });
    } catch {
      /* board settle is best-effort */
    }
  }
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
  // SHOW THE RESULT (FIRM): a mission that finished cleanly ends by SERVING what it built and
  // opening it for the user — never leaving them to discover how to run it. No-op when the
  // project has nothing runnable to serve. Best-effort; a preview fault never fails the mission.
  if (state.outcome === 'completed') {
    await showResult(deps, repoRoot);
  }
  return state;
}
