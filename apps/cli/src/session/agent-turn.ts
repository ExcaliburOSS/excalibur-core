import {
  resolveAgentAdapter,
  type AgentAdapter,
  type ConfirmationRequest,
} from '@excalibur/agent-runtime';
import {
  addWorktree,
  applyPatch,
  buildMemoryContext,
  buildTurnSummary,
  checkPatchApplies,
  commitAll,
  EXCALIBUR_DIR,
  getGitInfo,
  hasCommits,
  buildPlanMemoryEntry,
  loadReplay,
  MemoryStore,
  nextPendingStep,
  parsePlanMarkdown,
  planFork,
  planProgress,
  planUndo,
  readPlan,
  removeWorktree,
  restampEventsForFork,
  resumablePlans,
  RunManager,
  runStructuredPlan,
  savePlan,
  setPlanStatus,
  turnSummaryToMarkdown,
  updatePlanStep,
  type PlanStepExecutor,
  type StoredPlan,
  type StructuredPlan,
  type StructuredPlanStep,
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
import {
  applyCustomColors,
  detectColorTier,
  detectThemeSync,
  paletteFor,
  type MissionRibbonModel,
  type PlanRibbonModel,
  type PlanRibbonOutcome,
} from '@excalibur/tui';
import type { RunViewHandle } from '@excalibur/tui/ink';
import type { ChatMessage, ModelGateway } from '@excalibur/model-gateway';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pc from 'picocolors';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { describeEvent } from '../lib/run-pipeline';
import { renderTurnReceipt } from '../lib/turn-receipt';
import { ActionRenderer, activityFor } from '../lib/action-render';
import { setAutoApprove } from '../lib/config-file';
import { materializePlanIntoWorkItems, syncStepWorkItemLane } from '../lib/plan-work-items';
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
  /**
   * Peak prompt (input) tokens the provider reported across this turn's model
   * calls — the real measure of how full the context window got. Undefined when
   * no usage was reported (e.g. the offline mock). Used by the REPL to drive
   * accurate compaction triggering instead of a chars/4 heuristic.
   */
  inputTokens?: number;
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
   * Active self-contained custom agent (P1.7b — selected with `/agent <name>`):
   * its persona/model/sampling/guardrails override the turn defaults. Additive —
   * absent → the standard role/provider for the autonomy level.
   */
  agent?: {
    name: string;
    systemPrompt?: string;
    role?: AgentRole;
    model?: string;
    provider?: string;
    temperature?: number;
    allowedTools?: string[];
    permissions?: ExcaliburConfig['permissions'];
  };
  /**
   * Background mode: suppress ALL foreground presentation (no Ink rail, no
   * spinner, no per-event render, no headers/receipt) and auto-approve tool
   * calls — the run is still fully recorded to its `events.jsonl`. Used by
   * `/bg` so a thread can run without fighting the live prompt. Blocked paths
   * stay hard-denied at the tool-execution layer regardless.
   */
  quiet?: boolean;
  /**
   * An EXISTING Ink rail to render this turn INTO, instead of mounting its own
   * (M8 #43 — the meta-orchestrator pins a plan ribbon and nests each capability's
   * rail beneath it). When set, runAgentTurn pushes events/narration to this view
   * and does NOT mount/unmount it or touch stdin — the owner (the mission) manages
   * its lifecycle. Additive; ordinary turns omit it and mount their own.
   */
  view?: RunViewHandle;
  /**
   * The meta-orchestrator's plan ribbon to pin ABOVE this turn's rail (M8 #43) —
   * so each capability runs with the mission DAG shown on top. Additive.
   */
  ribbon?: MissionRibbonModel;
  /**
   * The live PLAN ribbon (PLAN4) to pin ABOVE this turn's rail — the structured
   * plan as a phase→step tree, so a step runs with the whole plan shown on top
   * (set per step by {@link driveStructuredPlan}). Additive.
   */
  planRibbon?: PlanRibbonModel;
  /**
   * The interrupt handler (INT-1): invoked when the user types a message WHILE
   * this turn streams (Ink path only). It receives the raw input plus a live
   * {@link InterruptControl} over the running turn (abort, the rail ack sink, the
   * current-work context) so it can triage + route the interruption without
   * losing the work. Absent → the live view does not arm its typing channel.
   */
  onInterrupt?: (input: string, control: InterruptControl) => void | Promise<void>;
}

/** A live handle on the in-flight turn, handed to the interrupt handler (INT-1). */
export interface InterruptControl {
  /** A one-line description of what this turn is doing (triage context). */
  currentWork: string;
  /** True while the turn is blocked awaiting a user answer (an approval/question). */
  awaitingAnswer: boolean;
  /** The exact question being awaited, when `awaitingAnswer`. */
  pendingQuestion?: string;
  /** Files this turn has read/written so far (independence judgement input). */
  touchedPaths: string[];
  /** Abort the in-flight turn (an explicit stop, or before a pause+switch). */
  abort(): void;
  /** Show the instant acknowledgment line in the live rail. */
  say(text: string): void;
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
  /** Peak prompt (input) tokens across the turn's model calls (0 if unreported). */
  maxInputTokens: number;
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
  let maxInputTokens = 0;
  const turnStart = Date.now();
  const unicode = deps.env['EXCALIBUR_ASCII'] === undefined;

  // Interrupt channel (INT-1) state: what this turn is doing, whether it is
  // currently blocked awaiting a user answer (so a typed line can be read AS that
  // answer), and the files it has touched (independence input) — all handed to the
  // interrupt handler so it can triage a mid-run message without losing the work.
  const touchedPaths = new Set<string>();
  let awaitingAnswer = false;
  let pendingQuestion: string | undefined;

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
  // When the caller supplies a view (a mission nesting this capability under its
  // ribbon), render into it and let the caller own its lifecycle + stdin. Else
  // mount our own on a TTY.
  const externalView = turn.view ?? null;
  const useInk = externalView === null && turn.quiet !== true && deps.ui.isOutputTty();
  let view: RunViewHandle | null = externalView;
  if (useInk) {
    deps.ui.suspendInput();
    const ink = await loadInkUi();
    const mode = detectThemeSync() ?? 'dark';
    view = ink.mountRunView({
      palette: applyCustomColors(
        paletteFor(turn.config.ui?.theme ?? 'auto', mode),
        turn.config.ui?.customTheme,
      ),
      tier: detectColorTier(),
      mode,
      // The conversational shell slims the telemetry footer to time · tokens ·
      // cost (drops the internal level/safety/push/model jargon). `excalibur run`/
      // `patch` keep the full footer (they mount their own view).
      compactStatus: true,
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
        // No vars → the `{count}` placeholder survives for the renderer to fill.
        earlier: deps.t('rail.earlier'),
      },
    });
    view.onEscape(() => ctrl.abort());
  }
  // Pin the mission ribbon above the rail (whether we mounted the view or the
  // caller supplied one), so each capability runs under the live plan DAG.
  if (view !== null && turn.ribbon !== undefined) {
    view.setRibbon(turn.ribbon);
  }
  // Pin the live plan ribbon (PLAN4) above the rail, so a plan step runs under
  // the whole phase→step tree with its own node lit up.
  if (view !== null && turn.planRibbon !== undefined) {
    view.setPlanRibbon(turn.planRibbon);
  }

  // Arm the interrupt channel (INT-1): each message the user types while this
  // turn streams is handed to the handler with a live control over the run. Only
  // on the Ink path (it owns stdin); disarmed in the finally.
  let interruptOff: (() => void) | null = null;
  if (view !== null && turn.onInterrupt !== undefined) {
    const interruptView = view;
    const handler = turn.onInterrupt;
    interruptOff = interruptView.onInterrupt((text) => {
      void Promise.resolve(
        handler(text, {
          currentWork: options.prompt,
          awaitingAnswer,
          ...(pendingQuestion !== undefined ? { pendingQuestion } : {}),
          touchedPaths: [...touchedPaths],
          abort: () => ctrl.abort(),
          say: (s) => interruptView.noticeInterrupt(s),
        }),
      ).catch(() => {
        /* triage is best-effort — a handler error never breaks the turn */
      });
    });
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
    // Mark the turn as awaiting an answer so a typed interrupt during the gate is
    // read in that light (the answer feeds it; a side-question re-asks after).
    awaitingAnswer = true;
    pendingQuestion = question;
    try {
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
    } finally {
      awaitingAnswer = false;
      pendingQuestion = undefined;
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

  // Active custom agent (P1.7b /agent): its persona/model/sampling/guardrails
  // override the turn defaults. role + provider fall back to the turn's when the
  // agent doesn't pin them; the rest (systemPrompt/temperature/allowedTools/
  // permissions) apply only when set. Mirrors execute-local-run's agent overrides.
  const agent = turn.agent;
  // A const snapshot of the live view so the narration closure narrows cleanly
  // (the `view` binding is a reassignable `let`).
  const liveView = view;
  const stream = adapter.run({
    runId: run.id,
    sessionId,
    workdir: options.workdir ?? turn.repoRoot,
    prompt: options.prompt,
    role: agent?.role ?? options.role,
    provider: agent?.provider ?? turn.providerName,
    config: turn.config,
    gateway: turn.gateway,
    signal: ctrl.signal,
    ...(agent?.model !== undefined ? { model: agent.model } : {}),
    ...(agent?.temperature !== undefined ? { temperature: agent.temperature } : {}),
    ...(agent?.systemPrompt !== undefined ? { systemPrompt: agent.systemPrompt } : {}),
    ...(agent?.allowedTools !== undefined ? { allowedTools: agent.allowedTools } : {}),
    ...(agent?.permissions !== undefined ? { permissions: agent.permissions } : {}),
    ...(options.allowConfirm ? { confirm } : {}),
    // Free-text human channel for the `question` tool (P1.8b): the interactive
    // shell IS a human at a prompt. deps.ui.ask returns '' when non-interactive,
    // which the tool reads as "no answer → proceed autonomously". Wrapped to flag
    // the turn as awaiting an answer (INT-1) so a typed interrupt is read as it.
    ask: async (question: string): Promise<string> => {
      awaitingAnswer = true;
      pendingQuestion = question;
      try {
        return await deps.ui.ask(question);
      } finally {
        awaitingAnswer = false;
        pendingQuestion = undefined;
      }
    },
    ...(options.seedMessages !== undefined ? { seedMessages: options.seedMessages } : {}),
    // Live narration: when the Ink rail is up, type the model's prose out as it
    // streams (the warm pair-programmer voice, alive). The non-Ink/quiet paths
    // omit the sink → the loop runs a plain non-streamed turn.
    ...(liveView !== null
      ? {
          onNarration: ({ content }: { content: string }): void =>
            liveView.streamNarration(content),
        }
      : {}),
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

      // Track the files this turn touches (interrupt independence input, INT-1).
      if (event.type === 'file_read' || event.type === 'file_write') {
        const p = event.payload['path'];
        if (typeof p === 'string' && p.length > 0) touchedPaths.add(p);
      } else if (event.type === 'patch_generated') {
        const affected = event.payload['filesAffected'];
        if (Array.isArray(affected)) {
          for (const p of affected) if (typeof p === 'string' && p.length > 0) touchedPaths.add(p);
        }
      }

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
          maxInputTokens = Math.max(maxInputTokens, inputTokens);
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
    interruptOff?.(); // disarm the interrupt channel for this turn
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
      // An EXTERNAL (mission) view is owned by its caller — don't unmount it or
      // touch stdin here.
      if (useInk) {
        view.unmount();
        deps.ui.resumeInput();
      }
    } else {
      spinner?.stop();
    }
  }
  renderer?.finish();

  return { finalText, costCents, model, mutated, aborted, maxInputTokens };
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

/** Path-like tokens named in a task (`src/x.ts`, `dir/file`, `foo.json`). */
export function pathsFromText(text: string): string[] {
  const matches = text.match(/[\w@.-]+\/[\w./-]+|[\w-]+\.[a-zA-Z][a-zA-Z0-9]+/g) ?? [];
  return [...new Set(matches)].slice(0, 20);
}

/** Working-set files (`git diff --name-only HEAD`); [] on any failure. */
function changedFiles(repoRoot: string): string[] {
  try {
    return execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 2000,
      // Discard the child's stderr — a commit-less repo makes `HEAD` invalid and
      // git prints "fatal: ambiguous argument 'HEAD'" to the inherited terminal.
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * Knowledge-compounding READ side: retrieve project memory relevant to the
 * working set + paths named in the task and return it as a LEADING system
 * message, so prior decisions / rejections / risks / conventions actually
 * influence the turn (the capture side already records them via /remember +
 * plan-save). Gated — `null` when nothing is relevant, so an unrelated turn is
 * untouched. Best-effort: never throws.
 */
export function memorySeed(repoRoot: string, task: string): ChatMessage | null {
  try {
    const queryPaths = [...new Set([...changedFiles(repoRoot), ...pathsFromText(task)])];
    if (queryPaths.length === 0) {
      return null;
    }
    const source = buildMemoryContext(repoRoot, queryPaths);
    return source === null ? null : { role: 'system', content: source.content };
  } catch {
    return null;
  }
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
    // DASH3: tag the background fleet (`/bg` + its follow-ups + supervisor reactions —
    // the only `quiet` path) with a distinct workflow so the dashboard can surface it.
    turn.quiet === true
      ? 'conversation-bg'
      : role === 'planner'
        ? 'conversation-ask'
        : 'conversation',
  );
  runManager.updateRecord(run.id, { status: 'running' });

  // No technical header / run-dir line here: the conversational shell leads with
  // the agent's warm narration (streamed in the live rail) — the user should never
  // see "→ agent · act · L4" or an internal run id/path. (The `run`/`patch` CLI
  // commands keep their own run-dir line; they never call runAgentTurn.)

  // Knowledge-compounding: prepend relevant project memory as a leading system
  // message so prior decisions actually influence the turn (gated; null → nothing).
  const memory = memorySeed(turn.repoRoot, task);
  const seed = memory !== null ? [memory, ...(seedMessages ?? [])] : (seedMessages ?? []);

  const result = await driveLoop(turn, adapter, runManager, run, generateId('sess'), {
    role,
    prompt: task,
    approvalDefaultYes: approvalDefaultYes(turn.autonomyLevel),
    allowConfirm: role !== 'planner',
    // Prior conversation (compacted) + injected memory so the turn has cross-turn
    // context. Empty → an independent turn, exactly as before.
    ...(seed.length > 0 ? { seedMessages: seed } : {}),
  });

  // Suppress the internal "■ run completed" line in the conversational shell —
  // the warm receipt below is the user-facing closure (we never expose "run").
  // The run_completed EVENT is still recorded for replay/time-machine.
  finishRun(turn.deps, runManager, run, result.aborted, true);
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
  turn.deps.ui.info(turn.deps.t('agent-turn.plan_header'));

  const planResult = await driveLoop(turn, adapter, runManager, planRun, generateId('sess'), {
    role: 'planner',
    prompt: `Produce a concise, numbered implementation plan for the following task. Use read-only tools to ground the plan in the actual repository; do NOT modify anything.\n\nTask: ${task}`,
    approvalDefaultYes: false,
    allowConfirm: false,
    ...seed,
  });
  finishRun(turn.deps, runManager, planRun, planResult.aborted, true); // no "run completed" chrome

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
  // Structure the approved plan. A multi-step plan executes STEP BY STEP with a
  // durable checkpoint persisted after each step (PLAN3) — so an interrupted run
  // (Ctrl-C, a crash, closing the laptop) resumes at the next unfinished step
  // instead of redoing everything. A trivial (≤1 step) plan runs in one pass.
  const plan = parsePlanMarkdown(planResult.finalText);
  const exec = await executeApprovedPlan(turn, adapter, runManager, {
    task,
    planText: planResult.finalText,
    plan,
    planRunId: planRun.id,
    seed,
  });

  return {
    gate: 'approve',
    planText: planResult.finalText,
    execution: exec.execution,
    planRunId: planRun.id,
  };
}

interface ExecutePlanInput {
  task: string;
  planText: string;
  plan: StructuredPlan;
  planRunId: string;
  seed: Pick<DriveOptions, 'seedMessages'>;
}

/**
 * Runs an approved plan. A plan with ≥2 steps executes step by step with a durable
 * checkpoint after each (PLAN3 — resumable), saved as `approved` first and flipped
 * to `executed` once every step finishes. A trivial plan runs in a single focused
 * implementer pass (the original behaviour). Either way the plan is persisted to
 * the PLANS folder and promoted to project memory (Knowledge Compounding).
 */
async function executeApprovedPlan(
  turn: AgentTurnDeps,
  adapter: AgentAdapter,
  runManager: RunManager,
  input: ExecutePlanInput,
): Promise<{ execution: AgentTurnResult | null }> {
  const { task, planText, plan, planRunId, seed } = input;
  const total = planProgress(plan).total;

  // Step-by-step checkpointing (PLAN3) is reserved for genuinely LARGE work —
  // a structured multi-PHASE plan, or a long flat one (≥5 steps) — where an
  // interruption is costly and resumability earns its keep. A small flat plan
  // (a few steps under one phase) runs better as ONE focused implementer pass:
  // full context, no per-step fragmentation. Either way the structured plan is
  // persisted; only the large path gets the resumable per-step checkpoint.
  const stepwise = total >= 2 && (plan.phases.length >= 2 || total >= 5);

  // Small/flat plan → one monolithic implementer pass, saved as executed.
  if (!stepwise) {
    const execRun = createTurnRun(
      runManager,
      task,
      turn.autonomyLevel,
      turn.providerName,
      'conversation',
    );
    runManager.updateRecord(execRun.id, { status: 'running' });
    turn.deps.ui.write();
    turn.deps.ui.info(turn.deps.t('agent-turn.execute_header'));
    const execResult = await driveLoop(turn, adapter, runManager, execRun, generateId('sess'), {
      role: 'implementer',
      prompt: `Execute this approved plan for the task. Make the changes using the available tools.\n\nTask: ${task}\n\nApproved plan:\n${planText}`,
      approvalDefaultYes: approvalDefaultYes(turn.autonomyLevel),
      allowConfirm: true,
      ...seed,
    });
    finishRun(turn.deps, runManager, execRun, execResult.aborted, true);
    emitReceipt(turn, runManager, execRun.id, execResult.model || turn.providerName);
    if (planText.trim().length > 0) {
      try {
        const file = savePlan(turn.repoRoot, {
          task,
          planMarkdown: planText,
          plan,
          status: 'executed',
          planRunId,
          execRunId: execRun.id,
        });
        turn.deps.ui.info(turn.deps.t('agent-turn.plan_saved', { file: basename(file) }));
        // A flat plan runs as ONE pass — its steps carry no runId, so fold the
        // single exec run's files in via extraRunIds (PLAN6).
        capturePlanMemory(turn, plan, task, planRunId, {
          completed: true,
          extraRunIds: [execRun.id],
        });
      } catch {
        /* persistence is best-effort; the executed run already succeeded */
      }
    }
    return { execution: toResult(execRun.id, execResult, turn.providerName) };
  }

  // Multi-step → save as APPROVED first so the structured sidecar exists on disk
  // as a checkpoint BEFORE any step runs; then drive step by step.
  let planId: string | null = null;
  try {
    const file = savePlan(turn.repoRoot, {
      task,
      planMarkdown: planText,
      plan,
      status: 'approved',
      planRunId,
    });
    planId = basename(file).replace(/\.md$/, '');
  } catch {
    /* if the checkpoint can't be written we still execute (resume just won't persist) */
  }

  // PLAN2 — materialize the plan into the kanban: the plan becomes an EPIC, each
  // step a tracked sub-task with its deps as dependency edges. Idempotent + best-
  // effort (a work-items write must never abort the approved execution).
  if (planId !== null) {
    try {
      const wi = materializePlanIntoWorkItems(turn.repoRoot, planId, plan, task);
      if (wi.created > 0 && wi.epicWorkItemId !== null) {
        turn.deps.ui.info(
          turn.deps.t('agent-turn.plan_workitems', {
            epic: wi.epicWorkItemId,
            count: Object.keys(wi.stepWorkItemIds).length,
          }),
        );
      }
    } catch {
      /* materialization is best-effort; the plan still executes */
    }
  }

  turn.deps.ui.write();
  turn.deps.ui.info(turn.deps.t('agent-turn.plan_steps_header', { count: total }));
  return driveStructuredPlan(turn, adapter, runManager, { ...input, planId });
}

interface DrivePlanInput extends ExecutePlanInput {
  /** The saved plan id whose steps are checkpointed (null when the save failed). */
  planId: string | null;
}

/**
 * Projects the (in-place-mutated) structured plan into a live PLAN ribbon model
 * for the TUI — the terminal twin of the dashboard plan tree (PLAN4). Called per
 * step so the ribbon pinned above that step's rail shows the whole plan with the
 * current step lit up, prior steps done, the rest pending.
 */
function planToRibbon(
  plan: StructuredPlan,
  task: string,
  outcome: PlanRibbonOutcome,
): PlanRibbonModel {
  const { total, done } = planProgress(plan);
  return {
    task,
    done,
    total,
    outcome,
    phases: plan.phases.map((phase) => ({
      id: phase.id,
      title: phase.title,
      steps: phase.steps.map((s) => ({ id: s.id, title: s.title, status: s.status })),
    })),
  };
}

/**
 * The shared step-by-step driver (used by a fresh execute AND a resume). Drives the
 * structured plan through {@link runStructuredPlan}: each step is a focused
 * implementer pass, and every status transition is persisted via `updatePlanStep`
 * so the plan on disk is always an accurate, resumable checkpoint. Already-done
 * steps are skipped — which is exactly what makes a re-run a RESUME.
 */
async function driveStructuredPlan(
  turn: AgentTurnDeps,
  adapter: AgentAdapter,
  runManager: RunManager,
  input: DrivePlanInput,
): Promise<{ execution: AgentTurnResult | null }> {
  const { task, plan, planId, planRunId, seed } = input;
  const t = turn.deps.t;

  let lastRunId: string | null = null;
  let lastResult: DriveResult | null = null;
  let totalCost: number | null = null;
  let mutated = false;
  let peakInput = 0;

  const executor: PlanStepExecutor = async (step, ctx) => {
    const execRun = createTurnRun(
      runManager,
      `${task} — ${step.title}`,
      turn.autonomyLevel,
      turn.providerName,
      'conversation',
    );
    runManager.updateRecord(execRun.id, { status: 'running' });
    // Pin the live plan tree above this step's rail — the whole plan with this
    // step lit up, prior steps done, the rest pending (PLAN4). `ctx.plan` is the
    // in-place-mutated plan, so it already has this step marked `active`.
    const stepTurn: AgentTurnDeps = {
      ...turn,
      planRibbon: planToRibbon(ctx.plan, task, 'executing'),
    };
    const execResult = await driveLoop(stepTurn, adapter, runManager, execRun, generateId('sess'), {
      role: 'implementer',
      prompt: stepPrompt(task, ctx.plan, ctx.phase, step),
      approvalDefaultYes: approvalDefaultYes(turn.autonomyLevel),
      allowConfirm: true,
      ...seed,
    });
    finishRun(turn.deps, runManager, execRun, execResult.aborted, true);
    lastRunId = execRun.id;
    lastResult = execResult;
    if (execResult.costCents !== null) {
      totalCost = (totalCost ?? 0) + execResult.costCents;
    }
    mutated = mutated || execResult.mutated;
    peakInput = Math.max(peakInput, execResult.maxInputTokens);
    // An aborted step is left re-runnable (blocked, not done) so resume retries it.
    return { status: execResult.aborted ? 'blocked' : 'done', runId: execRun.id };
  };

  const result = await runStructuredPlan(plan, executor, {
    ...(turn.signal !== undefined ? { signal: turn.signal } : {}),
    onStep: (step) => {
      if (planId !== null) {
        try {
          updatePlanStep(turn.repoRoot, planId, step.id, step.status, step.runId);
        } catch {
          /* the on-disk checkpoint is best-effort; execution continues regardless */
        }
      }
      // PLAN2 — live-sync the step's linked work-item onto the matching kanban lane
      // (active → in_progress, done → done), so the board tracks execution.
      if (step.workItemId !== undefined) {
        syncStepWorkItemLane(turn.repoRoot, step.workItemId, step.status);
      }
      if (step.status === 'active') {
        turn.deps.ui.write();
        turn.deps.ui.info(t('agent-turn.plan_step_running', { step: step.title }));
      } else if (step.status === 'done') {
        turn.deps.ui.info(pc.green(t('agent-turn.plan_step_done', { step: step.title })));
      } else if (step.status === 'blocked') {
        turn.deps.ui.warn(t('agent-turn.plan_step_blocked', { step: step.title }));
      }
    },
  });

  if (result.completed) {
    if (planId !== null) {
      try {
        setPlanStatus(turn.repoRoot, planId, 'executed');
      } catch {
        /* best-effort */
      }
    }
    capturePlanMemory(turn, plan, task, planRunId, { completed: true });
    turn.deps.ui.write();
    turn.deps.ui.info(
      pc.green(t('agent-turn.plan_steps_done', { count: planProgress(plan).done })),
    );
  } else {
    // Paused/blocked → the plan stays APPROVED on disk (resumable). Point the way,
    // and record a PARTIAL plan memory (PLAN6) so the blocked area is remembered.
    const at = nextPendingStep(plan);
    capturePlanMemory(turn, plan, task, planRunId, {
      completed: false,
      blockedStepIds: result.blockedStepIds,
    });
    turn.deps.ui.write();
    if (at !== null) {
      turn.deps.ui.info(t('agent-turn.plan_steps_paused', { step: at.step.title }));
    }
  }

  if (lastRunId !== null && lastResult !== null) {
    const settled: DriveResult = lastResult;
    emitReceipt(turn, runManager, lastRunId, settled.model || turn.providerName);
    const aggregate: DriveResult = {
      finalText: settled.finalText,
      costCents: totalCost,
      model: settled.model,
      mutated,
      aborted: settled.aborted,
      maxInputTokens: peakInput,
    };
    return { execution: toResult(lastRunId, aggregate, turn.providerName) };
  }
  return { execution: null };
}

/** The implementer prompt for ONE plan step — the whole plan for context, the
 * already-done steps, and a hard instruction to complete only this step. */
function stepPrompt(
  task: string,
  plan: StructuredPlan,
  phase: { title: string },
  step: StructuredPlanStep,
): string {
  const done = plan.phases
    .flatMap((p) => p.steps)
    .filter((s) => s.status === 'done')
    .map((s) => `  ✓ ${s.title}`);
  const doneBlock =
    done.length > 0 ? `\n\nAlready completed (do not redo):\n${done.join('\n')}` : '';
  const acceptance =
    step.acceptance !== undefined && step.acceptance.length > 0
      ? `\nAcceptance: ${step.acceptance}`
      : '';
  const outline = plan.phases
    .map(
      (p) =>
        `${p.title}\n${p.steps.map((s) => `  - [${s.status === 'done' ? 'x' : ' '}] ${s.title}`).join('\n')}`,
    )
    .join('\n');
  return [
    'You are executing an approved, multi-step plan — ONE step at a time.',
    `Task: ${task}`,
    '',
    'Full plan (for context):',
    outline,
    doneBlock,
    '',
    'Now complete ONLY this step (do not start later steps):',
    `Phase: ${phase.title}`,
    `Step: ${step.title}${acceptance}`,
    '',
    'Make the changes with the available tools. When this step is complete, stop.',
  ].join('\n');
}

/** Promotes an executed plan to project MEMORY (Knowledge Compounding). Best-effort. */
/**
 * PLAN6 — promotes a finished plan to project MEMORY as a RICH, recall-friendly
 * entry: a structured outcome digest (phases→steps, epic, blocked) as the rationale
 * and the FILES TOUCHED as subjectPaths (the relevance key), so an executed plan
 * primes future work on the same files. Captures partial/blocked plans too (lower
 * confidence). Best-effort — never breaks the already-finished execution.
 */
function capturePlanMemory(
  turn: AgentTurnDeps,
  plan: StructuredPlan,
  task: string,
  planRunId: string,
  opts: { completed: boolean; blockedStepIds?: string[]; extraRunIds?: string[] },
): void {
  try {
    new MemoryStore(turn.repoRoot).capture(
      buildPlanMemoryEntry(turn.repoRoot, plan, {
        task,
        planRunId,
        completed: opts.completed,
        ...(opts.blockedStepIds !== undefined ? { blockedStepIds: opts.blockedStepIds } : {}),
        ...(opts.extraRunIds !== undefined ? { extraRunIds: opts.extraRunIds } : {}),
      }),
    );
  } catch {
    /* memory promotion is best-effort */
  }
}

/** The newest RESUMABLE plan (approved with a still-pending step) for this repo, or
 * null — so the shell can proactively offer to pick it up where it left off. */
export function findResumablePlan(repoRoot: string): StoredPlan | null {
  try {
    return resumablePlans(repoRoot)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Resumes a saved plan at its first unfinished step (PLAN3). Loads the structured
 * plan from disk (already-done steps are marked) and drives the rest step by step,
 * checkpointing each and flipping the plan to `executed` once complete. A plan that
 * is missing or already finished is a friendly no-op.
 */
export async function resumePlanTurn(
  turn: AgentTurnDeps,
  planId: string,
  seedMessages?: ChatMessage[],
): Promise<PlanTurnResult> {
  const stored = readPlan(turn.repoRoot, planId);
  if (stored === null) {
    turn.deps.ui.info(turn.deps.t('agent-turn.plan_resume_missing'));
    return { gate: 'cancel', planText: '', execution: null, planRunId: '' };
  }
  const at = nextPendingStep(stored.plan);
  if (at === null) {
    turn.deps.ui.info(turn.deps.t('agent-turn.plan_resume_complete', { task: stored.task }));
    return {
      gate: 'cancel',
      planText: stored.body,
      execution: null,
      planRunId: stored.planRun ?? '',
    };
  }

  const adapter = turn.adapter ?? resolveAgentAdapter(turn.config);
  const runManager = new RunManager(turn.repoRoot);
  const seed: Pick<DriveOptions, 'seedMessages'> =
    seedMessages !== undefined && seedMessages.length > 0 ? { seedMessages } : {};

  turn.deps.ui.write();
  turn.deps.ui.info(
    turn.deps.t('agent-turn.plan_resume_header', { task: stored.task, step: at.step.title }),
  );

  const planRunId = stored.planRun ?? '';
  const exec = await driveStructuredPlan(turn, adapter, runManager, {
    task: stored.task,
    planText: stored.body,
    plan: stored.plan,
    planId: stored.id,
    planRunId,
    seed,
  });

  return {
    gate: 'approve',
    planText: stored.body,
    execution: exec.execution,
    planRunId,
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
    ...(result.maxInputTokens > 0 ? { inputTokens: result.maxInputTokens } : {}),
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
