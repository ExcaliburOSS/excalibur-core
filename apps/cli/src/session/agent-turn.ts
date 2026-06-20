import {
  resolveAgentAdapter,
  type AgentAdapter,
  type ConfirmationRequest,
} from '@excalibur/agent-runtime';
import {
  addWorktree,
  applyPatch,
  buildTurnSummary,
  checkPatchApplies,
  commitAll,
  EXCALIBUR_DIR,
  getGitInfo,
  hasCommits,
  loadReplay,
  MemoryStore,
  planFork,
  planUndo,
  removeWorktree,
  restampEventsForFork,
  RunManager,
  savePlan,
  turnSummaryToMarkdown,
} from '@excalibur/core';
import { basename } from 'node:path';
import {
  AUTONOMY_LEVEL_LABELS,
  createEvent,
  generateId,
  type AgentRole,
  type AutonomyLevel,
  type ExcaliburConfig,
  type ExcaliburEvent,
  type LocalRun,
} from '@excalibur/shared';
import { detectColorTier, detectThemeSync, paletteFor } from '@excalibur/tui';
import type { RunViewHandle } from '@excalibur/tui/ink';
import type { ChatMessage, ModelGateway } from '@excalibur/model-gateway';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pc from 'picocolors';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { describeEvent } from '../lib/run-pipeline';
import { renderTurnReceipt } from '../lib/turn-receipt';
import { ActionRenderer, activityFor } from '../lib/action-render';
import { setAutoApprove } from '../lib/config-file';
import { loadInkUi } from '../ink/load';

/**
 * The model-FIRST conversational turn (M-Shell). A natural-language line is
 * handed straight to the real agentic loop ({@link NativeAgentAdapter}): the
 * MODEL decides whether to answer (read tools) or to edit/run (write tools),
 * governed by the session's autonomy level. There is NO keyword classifier
 * pre-deciding intent — this is the opencode/Claude-Code shape.
 *
 * Every turn is recorded as a real RunManager run (its own
 * `.excalibur/runs/<id>/` with `events.jsonl`), so a turn is replayable /
 * time-machine-able later. Tool approvals are inline (`confirm` →
 * `deps.ui.confirm`, respecting the safety preset's `[y/N]` default) and Ctrl-C
 * cancels the in-flight turn (`signal`).
 *
 * Mock-degraded vs real-agentic: with the mock provider the loop returns the
 * templated text answer (the mock requests no tools) — a graceful offline demo.
 * With a real provider the model drives the full read/edit/run loop.
 */

/** What an agent turn dispatch reports back to the REPL transcript. */
export interface AgentTurnResult {
  /** The final assistant text (the model's answer / summary). */
  text: string;
  /** Provider/model that answered. */
  model: string;
  /** Accumulated cost in cents across the turn's model calls (null if unknown). */
  costCents: number | null;
  /** The run id this turn produced (the events.jsonl lives there). */
  runId: string;
  /** Whether the loop mutated the working tree (a patch was generated). */
  mutated: boolean;
}

/**
 * Session-scoped approval policy (shared, mutable across a session's turns) so
 * the user approves edits ONCE rather than on every tool call. ONE concept:
 * - `auto`: never prompt — auto-approve every mutating tool (the `/auto` mode,
 *   like Claude Code's auto-accept). Set either by the session-start prompt or
 *   by answering "Auto mode" (`a`) at any per-edit prompt, and PERSISTED so
 *   future sessions don't re-ask. Blocked paths stay hard-denied regardless.
 */
export interface ApprovalState {
  auto: boolean;
}

export interface AgentTurnDeps {
  deps: CliDeps;
  repoRoot: string;
  config: ExcaliburConfig;
  gateway: ModelGateway;
  /** Provider name (e.g. `mock`) for status/transcript attribution. */
  providerName: string;
  /** The session's autonomy level — governs the role and approval strength. */
  autonomyLevel: AutonomyLevel;
  /** Session approval policy (auto-accept on/off); prompts per edit when absent or off. */
  approvals?: ApprovalState;
  /** Cancels the in-flight turn (Ctrl-C). */
  signal?: AbortSignal;
  /** Injectable adapter (tests pass a fake-gateway-backed native adapter). */
  adapter?: AgentAdapter;
  /**
   * Background mode: suppress ALL foreground presentation (no Ink rail, no
   * spinner, no per-event render, no headers/receipt) and auto-approve tool
   * calls — the run is still fully recorded to its `events.jsonl`. Used by
   * `/bg` so a thread can run without fighting the live prompt. Blocked paths
   * stay hard-denied at the tool-execution layer regardless.
   */
  quiet?: boolean;
}

/**
 * Maps the autonomy level onto the agent role for a conversational turn.
 *
 * - L0 Review / L1 Assist → `planner`: the read-only tool subset (read, list,
 *   search, diff). The model answers / advises; it can NEVER mutate the tree.
 * - L2 / L3 / L4 → `implementer`: the full tool set (read + write + run),
 *   gated by inline confirmations for anything the permission engine flags.
 */
export function roleForAutonomy(level: AutonomyLevel): AgentRole {
  return level <= 1 ? 'planner' : 'implementer';
}

/** Strength of the inline approval default, from the autonomy level. */
function approvalDefaultYes(level: AutonomyLevel): boolean {
  // L4 (full agentic) defaults to approve; everything below defaults to the
  // safe `[y/N]` (no — mutations need an explicit yes).
  return level >= 4;
}

/** Renders one streamed agent event to the terminal (reuses the run renderer). */
function renderEvent(deps: CliDeps, event: ExcaliburEvent): void {
  const line = describeEvent(deps.t, event);
  if (line !== null) {
    deps.ui.write(line);
  }
}

/**
 * Renders the post-turn receipt: a deterministic recap built from the run's
 * event stream (files changed, checks, cost) plus the model's final narrative.
 * Replaces a bare "print the final text" — the receipt SCALES to the work (a
 * plain answer is just the narrative + a footer; an action turn adds the
 * diffstat/file-list/next-step), and it persists the canonical `summary.md` so
 * the time-machine and Enterprise sync inherit it. Best-effort: a render/parse
 * failure never breaks the turn.
 */
function emitReceipt(
  turn: AgentTurnDeps,
  runManager: RunManager,
  runId: string,
  model: string,
): void {
  let summary;
  try {
    summary = buildTurnSummary(loadReplay(turn.repoRoot, runId));
  } catch {
    return;
  }
  try {
    runManager.writeArtifact(runId, 'summary.md', turnSummaryToMarkdown(summary));
  } catch {
    // Persisting the summary artifact is non-fatal.
  }
  renderTurnReceipt(turn.deps, summary, { now: new Date(), model });
}

interface DriveOptions {
  role: AgentRole;
  prompt: string;
  /** Inline tool-approval default (`[Y/n]` vs `[y/N]`). */
  approvalDefaultYes: boolean;
  /** When false, no tool approvals are offered (read-only planner pass). */
  allowConfirm: boolean;
  /** Working directory the loop operates in (defaults to the repo root; a fork
   * passes its isolated worktree). */
  workdir?: string;
  /** Cached conversation prefix for fork-from-cache (seeds the loop). */
  seedMessages?: ChatMessage[];
}

interface DriveResult {
  finalText: string;
  costCents: number | null;
  model: string;
  mutated: boolean;
  aborted: boolean;
}

/**
 * Drives ONE pass of the native agent loop against a run, streaming + recording
 * events, and collects the final assistant text, cost, model and whether the
 * tree was mutated.
 */
async function driveLoop(
  turn: AgentTurnDeps,
  adapter: AgentAdapter,
  runManager: RunManager,
  run: LocalRun,
  sessionId: string,
  options: DriveOptions,
): Promise<DriveResult> {
  const { deps } = turn;
  let finalText = '';
  let costCents: number | null = null;
  let model = turn.providerName;
  let mutated = false;
  let aborted = false;
  let totalTokens = 0;
  const turnStart = Date.now();
  const unicode = deps.env['EXCALIBUR_ASCII'] === undefined;

  // Own a local AbortController: it lets the Ink view's ESC/Ctrl-C cancel the
  // turn (Ink owns stdin while mounted, so the REPL's editor.onEscape is dormant)
  // while STILL honouring an upstream abort (a non-Ink Ctrl-C). One signal feeds
  // the adapter + the spinner, whichever presenter is active.
  const ctrl = new AbortController();
  const onUpstreamAbort = (): void => ctrl.abort();
  if (turn.signal !== undefined) {
    if (turn.signal.aborted) ctrl.abort();
    else turn.signal.addEventListener('abort', onUpstreamAbort);
  }

  // The live presenter: the Ink <RunView> rail on a TTY (the same one `run`
  // uses), or — on a piped/CI stdout — the spinner + per-action renderer. The
  // Ink rail OWNS stdin for the turn, so suspend the REPL's raw editor first and
  // resume it on unmount (in the finally).
  const useInk = turn.quiet !== true && deps.ui.isOutputTty();
  let view: RunViewHandle | null = null;
  if (useInk) {
    deps.ui.suspendInput();
    const ink = await loadInkUi();
    const mode = detectThemeSync() ?? 'dark';
    view = ink.mountRunView({
      palette: paletteFor(turn.config.ui?.theme ?? 'auto', mode),
      tier: detectColorTier(),
      mode,
      reduce: {
        autonomyLabel: AUTONOMY_LEVEL_LABELS[turn.autonomyLevel],
        safety: turn.config.safety?.preset ?? 'standard-safe',
        model: turn.providerName,
        push: false,
      },
      labels: {
        push: deps.t('rail.push'),
        noPush: deps.t('rail.noPush'),
        tasks: deps.t('rail.tasks'),
      },
    });
    view.onEscape(() => ctrl.abort());
  }

  // The breathing indicator + per-action renderer — non-Ink path only, and never
  // in quiet/background mode (the run records silently, nothing hits the prompt).
  const quiet = turn.quiet === true;
  const spinner = view === null && !quiet ? deps.ui.createSpinner({ unicode }) : null;
  const renderer = view === null && !quiet ? new ActionRenderer(deps, { unicode }) : null;
  // Cancel the indicator SYNCHRONOUSLY on abort so its next frame can't overwrite
  // a "Cancelled" message (and it never re-arms). Listener removed in finally.
  const onAbort = (): void => spinner?.cancel();
  ctrl.signal.addEventListener('abort', onAbort);
  const gerund = deps.t(gerundForRole(options.role, turn.config.ui?.flavor));
  const spinnerText = (activity: string | null): string => {
    const label = activity ?? gerund;
    const cost = costCents !== null ? ` · $${(costCents / 100).toFixed(2)}` : '';
    const toks = totalTokens > 0 ? ` · ${compactTokens(totalTokens)} tok` : '';
    const elapsed = ` · ${Math.round((Date.now() - turnStart) / 1000)}s`;
    return `${label}${pc.dim(toks + cost + elapsed)}`;
  };

  const confirm = async (req: ConfirmationRequest): Promise<boolean> => {
    // Approve-once UX: skip the prompt entirely when auto-accept is on (blocked
    // paths are still hard-denied at the tool-execution layer regardless).
    const approvals = turn.approvals;
    if (quiet || approvals?.auto === true) {
      return true;
    }
    const detail = req.detail !== undefined ? ` (${req.detail})` : '';
    const question = deps.t('agent-turn.tool_needs_approval', {
      tool: req.tool,
      reason: req.reason,
      detail,
    });
    let choice: 'yes' | 'no' | 'auto';
    if (view !== null) {
      // The approval renders inline in the rail; y/Return → yes, a → auto, n → no.
      choice = await view.requestApproval({
        question,
        options: options.approvalDefaultYes ? '[Y/n/a]' : '[y/N/a]',
      });
    } else {
      spinner!.stop(); // clear the transient line before the (permanent) prompt
      deps.ui.write(pc.yellow(question));
      choice = await deps.ui.confirmTool(deps.t('agent-turn.allow_action'), {
        defaultYes: options.approvalDefaultYes,
      });
    }
    // "Auto mode" (a): flip on session-wide auto-accept AND persist it, so this
    // is the LAST prompt — unified with the `/auto` mode (one concept). Counts
    // as approval for the current action too.
    if (choice === 'auto') {
      if (approvals !== undefined) {
        approvals.auto = true;
      }
      try {
        setAutoApprove(turn.repoRoot, true);
      } catch {
        /* persistence is best-effort; the in-session flag is what matters now */
      }
      // A deps.ui write would tear the Ink frame; the auto state shows in the rail.
      if (view === null) {
        deps.ui.info(deps.t('agent-turn.auto_enabled'));
      }
      return true;
    }
    return choice !== 'no';
  };

  const stream = adapter.run({
    runId: run.id,
    sessionId,
    workdir: options.workdir ?? turn.repoRoot,
    prompt: options.prompt,
    role: options.role,
    provider: turn.providerName,
    config: turn.config,
    gateway: turn.gateway,
    signal: ctrl.signal,
    ...(options.allowConfirm ? { confirm } : {}),
    ...(options.seedMessages !== undefined ? { seedMessages: options.seedMessages } : {}),
  });

  // Show the indicator during the FIRST wait (the opening model call). The loop
  // is wrapped so the spinner's timer is ALWAYS cleared, even if a write throws.
  spinner?.start(() => spinnerText(null));

  // A conversation turn has no workflow phases, so synthesize ONE "working" node
  // under which the rail expands the live tool activity (read/edit/run). Without
  // it, reduceRail would drop the phase-less events and show only the status
  // line. PERSIST it to the run (not just the view) so a later replay/`logs`
  // folds the SAME stream → live == replay (the byte-identical invariant). Only
  // on the Ink path: the non-TTY spinner never showed a phase, so its persisted
  // stream stays phase-less (and its output unchanged).
  let phaseStarted = false;
  if (view !== null) {
    const started = createEvent({
      runId: run.id,
      type: 'phase_started',
      payload: {
        name: deps.t(gerundForRole(options.role, turn.config.ui?.flavor)),
        phaseId: 'turn',
      },
    });
    runManager.appendEvent(run.id, started);
    view.push(started);
    phaseStarted = true;
  }

  try {
    for await (const event of stream) {
      if (view !== null) {
        view.push(event);
      } else if (renderer !== null) {
        spinner?.stop(); // erase the transient line before any permanent output
        renderer.onEvent(event);
      }
      runManager.appendEvent(run.id, event);

      if (event.type === 'model_call') {
        const m = event.payload['model'];
        if (typeof m === 'string' && m.length > 0) {
          model = m;
        }
        const c = event.payload['costCents'];
        if (typeof c === 'number') {
          costCents = (costCents ?? 0) + c;
        }
        const inputTokens = event.payload['inputTokens'];
        const outputTokens = event.payload['outputTokens'];
        if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
          totalTokens += inputTokens + outputTokens;
          runManager.appendModelCall(run.id, {
            provider: turn.config.models?.default ?? turn.providerName,
            model: typeof m === 'string' ? m : turn.providerName,
            inputTokens,
            outputTokens,
            costCents: typeof c === 'number' ? c : null,
            timestamp: new Date().toISOString(),
          });
        }
      }
      if (event.type === 'assistant_message') {
        const content = event.payload['content'];
        if (typeof content === 'string' && content.length > 0) {
          finalText = content;
        }
        if (event.payload['aborted'] === true) {
          aborted = true;
        }
      }
      if (event.type === 'patch_generated') {
        const diff = event.payload['diff'];
        if (typeof diff === 'string' && diff.trim().length > 0) {
          mutated = true;
          runManager.writeArtifact(run.id, 'diff.patch', `${diff}\n`);
        }
        const affected = event.payload['filesAffected'];
        if (Array.isArray(affected) && affected.length > 0) {
          mutated = true;
        }
      }

      // Re-arm the indicator for the NEXT wait: the grounded activity that follows
      // this event (a tool announcement → "Running …" during execution), else the
      // role gerund while the model reasons before the next turn. (Ink presenter
      // animates from its own tick, so this is the spinner path only.)
      if (view === null) {
        const activity = activityFor(event);
        spinner!.start(() => spinnerText(activity));
      }
    }
  } finally {
    ctrl.signal.removeEventListener('abort', onAbort);
    if (turn.signal !== undefined) {
      turn.signal.removeEventListener('abort', onUpstreamAbort);
    }
    if (view !== null) {
      // CLOSE the synthetic working node here — runs exactly once on a clean exit,
      // an abort, OR a mid-loop throw (e.g. a persist error), so the persisted /
      // replayed stream never has a phase_started without its completion (which
      // would freeze a spinning node). Must run BEFORE unmount. Best-effort
      // persist so a disk fault here can't mask the original error.
      if (phaseStarted) {
        const completed = createEvent({
          runId: run.id,
          type: 'phase_completed',
          payload: { phaseId: 'turn' },
        });
        try {
          runManager.appendEvent(run.id, completed);
        } catch {
          /* persistence best-effort */
        }
        view.push(completed);
      }
      // Leaves the final frame (completed phases already in scrollback via
      // <Static>) and fully releases stdin; then re-arm the REPL's raw editor.
      view.unmount();
      deps.ui.resumeInput();
    } else {
      spinner?.stop();
    }
  }
  renderer?.finish();

  return { finalText, costCents, model, mutated, aborted };
}

/** Present-continuous label for the model "thinking" between tool calls, by role. */
/** The i18n key for a role's transient spinner gerund; translated at the call site. */
function gerundForRole(role: AgentRole, flavor?: string): string {
  const a = flavor === 'arthurian' ? '-arthurian' : '';
  switch (role) {
    case 'planner':
      return `agent-turn.gerund-planner${a}`;
    case 'architect':
      return `agent-turn.gerund-architect${a}`;
    case 'reviewer':
    case 'security':
      return `agent-turn.gerund-reviewer${a}`;
    case 'tester':
      return `agent-turn.gerund-tester${a}`;
    default:
      return `agent-turn.gerund-default${a}`;
  }
}

/** Compact token count for the indicator (`12.4k`, `340`). */
function compactTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

/**
 * Creates a fresh RunManager run for one conversational turn. The run is the
 * unit of replay: its `events.jsonl` records the whole loop.
 */
function createTurnRun(
  runManager: RunManager,
  task: string,
  level: AutonomyLevel,
  providerName: string,
  workflow: string,
): LocalRun {
  return runManager.createRun({
    title: task,
    autonomyLevel: level,
    workflow,
    methodology: null,
    model: providerName,
    executionStyle: 'team_default',
  });
}

/**
 * Runs a single model-driven conversational turn (no plan gate). The role is
 * derived from the autonomy level; the model decides whether to answer or act.
 */
export async function runAgentTurn(
  turn: AgentTurnDeps,
  task: string,
  seedMessages?: ChatMessage[],
): Promise<AgentTurnResult> {
  const adapter = turn.adapter ?? resolveAgentAdapter(turn.config);
  const runManager = new RunManager(turn.repoRoot);
  const role = roleForAutonomy(turn.autonomyLevel);
  const run = createTurnRun(
    runManager,
    task,
    turn.autonomyLevel,
    turn.providerName,
    role === 'planner' ? 'conversation-ask' : 'conversation',
  );
  runManager.updateRecord(run.id, { status: 'running' });

  if (turn.quiet !== true) {
    turn.deps.ui.info(
      turn.deps.t('agent-turn.agent_header', {
        mode:
          role === 'planner'
            ? turn.deps.t('agent-turn.mode_answer')
            : turn.deps.t('agent-turn.mode_act'),
        level: turn.autonomyLevel,
      }),
    );
    turn.deps.ui.info(turn.deps.t('agent-turn.run_dir', { id: run.id, dir: run.dir }));
  }

  const result = await driveLoop(turn, adapter, runManager, run, generateId('sess'), {
    role,
    prompt: task,
    approvalDefaultYes: approvalDefaultYes(turn.autonomyLevel),
    allowConfirm: role !== 'planner',
    // Prior conversation (compacted) so the turn has cross-turn memory. Omitted
    // (no key) → an independent turn, exactly as before.
    ...(seedMessages !== undefined && seedMessages.length > 0 ? { seedMessages } : {}),
  });

  finishRun(turn.deps, runManager, run, result.aborted, turn.quiet === true);
  if (turn.quiet !== true) {
    emitReceipt(turn, runManager, run.id, result.model || turn.providerName);
  }
  return toResult(run.id, result, turn.providerName);
}

/** Outcome of presenting a plan to the user. */
export type PlanGate = 'approve' | 'edit' | 'cancel';

export interface PlanTurnResult {
  /** What the user decided at the plan gate. */
  gate: PlanGate;
  /** The plan text the planner produced (always present). */
  planText: string;
  /** The execution result, present only when the plan was approved + executed. */
  execution: AgentTurnResult | null;
  /** The plan run id (always present — the plan is a real run too). */
  planRunId: string;
}

/**
 * Plan-mode: run the loop with the READ-ONLY planner role first to PRODUCE a
 * plan (read/list/search tools, no mutation), present it, then gate on
 * `[approve / edit / cancel]`:
 *  - approve → re-run with the implementer role (write tools) to EXECUTE;
 *  - edit    → returns `gate: 'edit'` so the REPL can amend + re-plan;
 *  - cancel  → stops (no execution).
 *
 * The plan and the execution are SEPARATE runs (each replayable). The gate is
 * skipped (auto-approve) on a non-interactive Ui — the safe default there is to
 * present the plan and stop, so a piped session never executes a plan blind;
 * we therefore return `gate: 'cancel'` when non-interactive.
 */
export async function runPlanTurn(
  turn: AgentTurnDeps,
  task: string,
  seedMessages?: ChatMessage[],
): Promise<PlanTurnResult> {
  const adapter = turn.adapter ?? resolveAgentAdapter(turn.config);
  const runManager = new RunManager(turn.repoRoot);
  const seed: Pick<DriveOptions, 'seedMessages'> =
    seedMessages !== undefined && seedMessages.length > 0 ? { seedMessages } : {};

  // --- 1. Plan pass (planner role, read-only) ------------------------------
  const planRun = createTurnRun(runManager, task, turn.autonomyLevel, turn.providerName, 'plan');
  runManager.updateRecord(planRun.id, { status: 'running' });
  turn.deps.ui.info(turn.deps.t('agent-turn.plan_header', { level: turn.autonomyLevel }));
  turn.deps.ui.info(turn.deps.t('agent-turn.run_dir', { id: planRun.id, dir: planRun.dir }));

  const planResult = await driveLoop(turn, adapter, runManager, planRun, generateId('sess'), {
    role: 'planner',
    prompt: `Produce a concise, numbered implementation plan for the following task. Use read-only tools to ground the plan in the actual repository; do NOT modify anything.\n\nTask: ${task}`,
    approvalDefaultYes: false,
    allowConfirm: false,
    ...seed,
  });
  finishRun(turn.deps, runManager, planRun, planResult.aborted);

  // Present the plan.
  turn.deps.ui.write();
  turn.deps.ui.heading(turn.deps.t('agent-turn.plan_heading'));
  turn.deps.ui.write(planResult.finalText);
  turn.deps.ui.write();

  if (planResult.aborted) {
    return {
      gate: 'cancel',
      planText: planResult.finalText,
      execution: null,
      planRunId: planRun.id,
    };
  }

  // --- 2. Gate -------------------------------------------------------------
  // Non-interactive: present + stop (never execute a plan blind in CI/piped).
  if (!turn.deps.ui.isInteractive()) {
    turn.deps.ui.info(turn.deps.t('agent-turn.plan_non_interactive'));
    return {
      gate: 'cancel',
      planText: planResult.finalText,
      execution: null,
      planRunId: planRun.id,
    };
  }

  const answer = (
    await turn.deps.ui.ask(turn.deps.t('agent-turn.plan_gate_prompt'), { defaultAnswer: 'cancel' })
  )
    .trim()
    .toLowerCase();
  const gate: PlanGate =
    answer === 'approve' || answer === 'a' || answer === 'y' || answer === 'yes'
      ? 'approve'
      : answer === 'edit' || answer === 'e'
        ? 'edit'
        : 'cancel';

  if (gate === 'edit') {
    turn.deps.ui.info(turn.deps.t('agent-turn.plan_edit'));
    return { gate, planText: planResult.finalText, execution: null, planRunId: planRun.id };
  }
  if (gate === 'cancel') {
    turn.deps.ui.info(turn.deps.t('agent-turn.plan_cancelled'));
    return { gate, planText: planResult.finalText, execution: null, planRunId: planRun.id };
  }

  // --- 3. Execute pass (implementer role, write tools) ---------------------
  const execRun = createTurnRun(
    runManager,
    task,
    turn.autonomyLevel,
    turn.providerName,
    'conversation',
  );
  runManager.updateRecord(execRun.id, { status: 'running' });
  turn.deps.ui.write();
  turn.deps.ui.info(turn.deps.t('agent-turn.execute_header', { level: turn.autonomyLevel }));
  turn.deps.ui.info(turn.deps.t('agent-turn.run_dir', { id: execRun.id, dir: execRun.dir }));

  const execResult = await driveLoop(turn, adapter, runManager, execRun, generateId('sess'), {
    role: 'implementer',
    prompt: `Execute this approved plan for the task. Make the changes using the available tools.\n\nTask: ${task}\n\nApproved plan:\n${planResult.finalText}`,
    approvalDefaultYes: approvalDefaultYes(turn.autonomyLevel),
    allowConfirm: true,
    ...seed,
  });
  finishRun(turn.deps, runManager, execRun, execResult.aborted);
  emitReceipt(turn, runManager, execRun.id, execResult.model || turn.providerName);

  // Persist the approved plan to the PLANS folder (portable, re-runnable .md) and
  // promote it to project MEMORY (Knowledge Compounding) — neither CC nor
  // OpenCode do this. Best-effort: a write fault never fails the executed run.
  if (planResult.finalText.trim().length > 0) {
    try {
      const file = savePlan(turn.repoRoot, {
        task,
        planMarkdown: planResult.finalText,
        status: 'executed',
        planRunId: planRun.id,
        execRunId: execRun.id,
      });
      turn.deps.ui.info(turn.deps.t('agent-turn.plan_saved', { file: basename(file) }));
      new MemoryStore(turn.repoRoot).capture({
        type: 'decision',
        statement: `Approved & executed a plan for: ${task}`,
        rationale: planResult.finalText.slice(0, 600),
        sourceRunId: planRun.id,
      });
    } catch {
      /* persistence is best-effort; the executed run already succeeded */
    }
  }

  return {
    gate: 'approve',
    planText: planResult.finalText,
    execution: toResult(execRun.id, execResult, turn.providerName),
    planRunId: planRun.id,
  };
}

/** Marks the run completed/cancelled and emits a final `run_completed` event. */
function finishRun(
  deps: CliDeps,
  runManager: RunManager,
  run: LocalRun,
  aborted: boolean,
  quiet = false,
): void {
  const status = aborted ? 'cancelled' : 'completed';
  runManager.updateRecord(run.id, { status, completedAt: new Date().toISOString() });
  const event = createEvent({ runId: run.id, type: 'run_completed', payload: { status } });
  runManager.appendEvent(run.id, event);
  if (!quiet) renderEvent(deps, event);
}

function toResult(runId: string, result: DriveResult, providerName: string): AgentTurnResult {
  return {
    text: result.finalText.length > 0 ? result.finalText : 'Done.',
    model: result.model || providerName,
    costCents: result.costCents,
    runId,
    mutated: result.mutated,
  };
}

/** `$0.04`, or `—` when no cost is known. */
function fmtCost(costCents: number | null): string {
  return costCents === null ? '—' : `$${(costCents / 100).toFixed(2)}`;
}

/**
 * Adds a pattern to `.git/info/exclude` (the local, uncommitted ignore list) so
 * a fork worktree never pollutes the user's `git status` / `git add`, regardless
 * of whether `.excalibur/` is gitignored. Best-effort: skips silently when `.git`
 * is absent or is a linked-worktree file rather than a directory.
 */
function excludeFromGit(repoRoot: string, pattern: string): void {
  try {
    const gitDir = join(repoRoot, '.git');
    if (!existsSync(gitDir)) {
      return;
    }
    const excludePath = join(gitDir, 'info', 'exclude');
    let current = '';
    try {
      current = readFileSync(excludePath, 'utf8');
    } catch {
      current = '';
    }
    if (current.split('\n').some((line) => line.trim() === pattern)) {
      return;
    }
    const prefix = current.length === 0 || current.endsWith('\n') ? '' : '\n';
    appendFileSync(excludePath, `${prefix}${pattern}\n`);
  } catch {
    // Best-effort — never fail a fork over the ignore list.
  }
}

/** Input to {@link runForkTurn}. `atStep` is 0-based (the CLI converts from 1-based). */
export interface ForkTurnInput {
  sourceRunId: string;
  atStep: number;
  instruction: string;
}

export interface ForkTurnResult {
  forkRunId: string;
  worktreePath: string;
  branch: string;
  cachedTokens: { input: number; output: number };
  cachedCostCents: number | null;
  execution: AgentTurnResult;
}

/**
 * Fork-from-cache (time-machine T2): branch a NEW run from step N of a source
 * run. The prefix (0..N) is replayed FROM CACHE — its events are copied into the
 * fork's log (marked cached) and its conversation reconstructed as the loop's
 * seed, so not a single token of the good work is re-spent — and only the new
 * `instruction` runs LIVE, in an isolated git worktree whose files are
 * reconstructed to the state at N. "Start from scratch" disappears.
 *
 * Safety: needs a git repo with a commit (the worktree base). If the run's
 * accumulated diff does not apply onto the current HEAD (the tree diverged) the
 * worktree is torn down and the fork fails cleanly rather than half-built.
 */
export async function runForkTurn(
  turn: AgentTurnDeps,
  input: ForkTurnInput,
): Promise<ForkTurnResult> {
  const { deps } = turn;
  const runManager = new RunManager(turn.repoRoot);

  if (!getGitInfo(turn.repoRoot).isRepo) {
    throw new Error(
      'Fork needs a git repository — the worktree is reconstructed from a base commit.',
    );
  }
  if (!hasCommits(turn.repoRoot)) {
    throw new Error('Fork needs at least one commit to base the reconstructed worktree on.');
  }

  const plan = planFork(turn.repoRoot, input.sourceRunId, input.atStep);
  if (plan.source.totalSteps === 0) {
    throw new Error(`Source run "${input.sourceRunId}" has no events to fork from.`);
  }

  const forkRun = runManager.createRun({
    title: input.instruction,
    autonomyLevel: turn.autonomyLevel,
    workflow: 'fork',
    methodology: null,
    model: turn.providerName,
    executionStyle: 'team_default',
  });
  runManager.updateRecord(forkRun.id, {
    status: 'running',
    forkedFrom: { runId: plan.source.runId, atStep: plan.source.atStep },
  });

  // Copy the cached prefix into the fork's log so the fork is itself replayable.
  for (const event of restampEventsForFork(plan.prefixEvents, forkRun.id)) {
    runManager.appendEvent(forkRun.id, event);
  }

  // Keep the worktree dir out of the user's git status regardless of whether
  // `.excalibur/` is gitignored (a nested worktree would otherwise show up /
  // get staged as a broken gitlink).
  excludeFromGit(turn.repoRoot, '.excalibur/worktrees/');

  const worktreePath = join(turn.repoRoot, EXCALIBUR_DIR, 'worktrees', forkRun.id);
  const branch = `excalibur/fork-${forkRun.id}`;
  addWorktree(turn.repoRoot, worktreePath, { branch });

  // From here, ANY failure must tear down the worktree and mark the run failed —
  // never leave an orphaned worktree or a run stuck "running".
  try {
    if (plan.baseDiff.trim().length > 0) {
      if (plan.baseDiff.includes('[REDACTED]')) {
        deps.ui.warn(deps.t('agent-turn.fork_redacted'));
      }
      const check = checkPatchApplies(worktreePath, plan.baseDiff);
      applyPatch(worktreePath, plan.baseDiff, check.applies ? undefined : { threeway: true });
      // Commit the reconstructed base so the SUFFIX's diff is purely the new
      // work (not the replayed prefix). Best-effort: a repo without a usable
      // identity simply keeps the base uncommitted.
      commitAll(worktreePath, `excalibur: reconstructed base @ step ${plan.source.atStep + 1}`);
    }

    const cachedTokens = plan.cachedTokens.input + plan.cachedTokens.output;
    deps.ui.info(
      deps.t('agent-turn.fork_header', {
        runId: plan.source.runId,
        step: plan.source.atStep + 1,
        total: plan.source.totalSteps,
      }),
    );
    deps.ui.info(
      deps.t('agent-turn.fork_reused', {
        tokens: cachedTokens,
        cost: fmtCost(plan.cachedCostCents),
      }),
    );
    deps.ui.info(deps.t('agent-turn.fork_worktree', { worktree: worktreePath, branch }));

    // Drive ONLY the live suffix: the implementer executes the new instruction
    // with the cached prefix seeded, inside the reconstructed worktree.
    const adapter = turn.adapter ?? resolveAgentAdapter(turn.config);
    const result = await driveLoop(turn, adapter, runManager, forkRun, generateId('sess'), {
      role: 'implementer',
      prompt: input.instruction,
      approvalDefaultYes: approvalDefaultYes(turn.autonomyLevel),
      allowConfirm: true,
      workdir: worktreePath,
      seedMessages: plan.seedMessages,
    });
    finishRun(deps, runManager, forkRun, result.aborted);
    emitReceipt(turn, runManager, forkRun.id, result.model || turn.providerName);

    return {
      forkRunId: forkRun.id,
      worktreePath,
      branch,
      cachedTokens: plan.cachedTokens,
      cachedCostCents: plan.cachedCostCents,
      execution: toResult(forkRun.id, result, turn.providerName),
    };
  } catch (error) {
    removeWorktree(turn.repoRoot, worktreePath, { force: true });
    runManager.updateRecord(forkRun.id, {
      status: 'failed',
      completedAt: new Date().toISOString(),
    });
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Fork failed at step ${plan.source.atStep + 1}: ${reason}. ` +
        `The worktree was torn down; nothing in your working tree changed.`,
    );
  }
}

/**
 * Undo-to-checkpoint (time-machine T2): revert the WORKING TREE to a run's state
 * at step `atStep` (0-based). Shared by `excalibur undo`, the `/undo` shell
 * command and the scrubber's `u` key so the safety logic lives in ONE place.
 *
 * Conservative + gated: it reverse-applies the run's changes only after a
 * `git apply --check` pre-flight (a diverged tree aborts with NO mutation), then
 * re-applies up to the checkpoint — and if that re-apply will not land, it
 * RESTORES the original tree and throws, never leaving a half-state or a
 * silently-wrong step. Throws {@link CliUsageError} on the abort paths so the
 * command surfaces a clean usage error; callers inside a loop (the scrubber)
 * should try/catch and route the message to the UI.
 */
export async function runUndo(
  deps: CliDeps,
  runId: string,
  atStep: number,
  options: { yes?: boolean } = {},
): Promise<void> {
  const repoRoot = deps.cwd();
  const plan = planUndo(repoRoot, runId, atStep);

  if (plan.fullDiff.trim().length === 0) {
    deps.ui.info(deps.t('agent-turn.undo_no_changes', { runId }));
    return;
  }

  // Pre-flight: can we cleanly unwind the run's changes from the tree?
  const canReverse = checkPatchApplies(repoRoot, plan.fullDiff, { reverse: true });
  if (!canReverse.applies) {
    throw new CliUsageError(
      deps.t('agent-turn.undo_cannot_reverse', { reason: canReverse.reason ?? 'diverged' }),
    );
  }

  deps.ui.warn(
    deps.t('agent-turn.undo_warn', {
      runId,
      step: plan.atStep + 1,
      total: plan.totalSteps,
    }),
  );
  // Always confirm unless `-y`: `confirm` returns its default (false) when
  // non-interactive, so a piped/non-TTY undo ABORTS rather than silently
  // mutating the tree.
  if (options.yes !== true) {
    const ok = await deps.ui.confirm(deps.t('agent-turn.undo_proceed'), { defaultYes: false });
    if (!ok) {
      deps.ui.info(deps.t('agent-turn.undo_cancelled'));
      return;
    }
  }

  // Unwind the run's changes (pre-flighted above), bringing the tree to the base.
  applyPatch(repoRoot, plan.fullDiff, { reverse: true });

  if (plan.targetDiff.trim().length === 0) {
    deps.ui.info(pc.green(deps.t('agent-turn.undo_reverted_full')));
    return;
  }

  // Re-apply up to the checkpoint; on a non-applying target, RESTORE the original
  // tree (forward-apply) and abort — never silently land at a different step.
  const canReapply = checkPatchApplies(repoRoot, plan.targetDiff);
  if (!canReapply.applies) {
    applyPatch(repoRoot, plan.fullDiff);
    throw new CliUsageError(
      deps.t('agent-turn.undo_cannot_reapply', {
        step: plan.atStep + 1,
        reason: canReapply.reason ?? 'no clean apply',
      }),
    );
  }
  applyPatch(repoRoot, plan.targetDiff);
  deps.ui.info(pc.green(deps.t('agent-turn.undo_reverted_step', { step: plan.atStep + 1 })));
}
