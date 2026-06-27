import {
  SessionStore,
  buildSessionSeed,
  buildStatusLineModel,
  buildTurnSummary,
  changeGlyph,
  classifyOrchestrationAction,
  classifyScheduleExtraction,
  classifyTurnDecision,
  ScheduleStore,
  parseScheduleSpec,
  nextRun,
  describeSpec,
  type ScheduledJob,
  planShape,
  shouldSurfacePlanShape,
  shouldAskPlanQuestions,
  parseChain,
  superviseCompletion,
  type TaskChain,
  type PlanShape,
  decidePosture,
  riskOfShape,
  compactSession,
  compactSessionAsync,
  createExtensionHost,
  createModelSummarizer,
  DEFAULT_COMPACTION_CONFIG,
  expandCustomCommand,
  loadCustomCommands,
  loadCustomAgents,
  resolveCustomAgent,
  type CustomAgent,
  withExtensionMcpServers,
  getGitIdentity,
  getGitInfo,
  getLocalDiff,
  loadReplay,
  MemoryStore,
  parseStructuralInput,
  decideInterrupt,
  type AsyncSummarizer,
  type IntentModel,
  type InterruptModel,
  type LocalSession,
  type RoutePosture,
  type TurnDecision,
  type TurnIntent,
} from '@excalibur/core';
import { analyzeRepository } from '@excalibur/context-engine';
import { agentUsesGateway, resolveAgentAdapter } from '@excalibur/agent-runtime';
import { estimateTokens, redactSecrets, type ChatMessage } from '@excalibur/model-gateway';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateId, type AutonomyLevel, type ExcaliburConfig } from '@excalibur/shared';
import { gaugeCells, paint } from '@excalibur/tui';
import pc from 'picocolors';
import { accent, resetCursorColor, setCursorAccent, shellPalette, shellTier } from '../lib/accent';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import {
  loadConfigContext,
  loadGatewayContext,
  requireConfiguredModel,
  safetyLine,
} from '../lib/context';
import { runDiscoveryFlow } from '../commands/discovery';
import { chooseBuildShape, decomposeTask, runSwarmFlow } from '../lib/swarm';
import { renderChronogramView } from '../commands/orchestration';
import { latestOrchestrationRunId, setOrchestrationPaused } from '../lib/orchestration-manifest';
import { runExploreFlow } from '../lib/explore';
import { runConfiguredCommandCheck } from '../lib/verify-command';
import { runProportionalMesh } from '../lib/verify-mesh';
import { runResearchFlow } from '../lib/research';
import { autoScopeForPlanning, runScopeFlow } from '../lib/scope';
import { withThinking, understandingPhrases, planningPhrases, decomposePhrases } from './thinking';
import { slashCommands } from './commands';
import { resolveRun, runScrubber } from '../lib/replay-scrubber';
import { buildSessionLog, formatSessionLog } from '../lib/session-log';
import { buildStartupContext } from '../lib/startup-context';
import { setAutoApprove } from '../lib/config-file';
import { repoSelectKeymap, writeProvidersFile } from '../lib/provider-setup';
import { isContextOverflowError } from '../lib/context-overflow';
import { listSwitchableProviders, providerHint } from '../lib/model-switch';
import { resolveSelectKeymap } from '../lib/keymap';
import { LOG_SENTINEL, REWIND_SENTINEL } from '../ui';
import { CLI_VERSION } from '../program';
import { renderWelcome, type WelcomeContext } from './welcome';
import {
  runAgentTurn,
  runForkTurn,
  runPlanTurn,
  runUndo,
  type AgentTurnDeps,
  type AgentTurnResult,
  type ApprovalState,
} from './agent-turn';
import { executeInterrupt, type InterruptOps } from './interrupt-exec';
import { runMissionTurn } from './mission-run';
import { runGoalLoop } from './goal-loop';
import { runIntervalLoop } from './interval-loop';
import { maybeAutoOnboard } from './onboarding';
import { resolveProjectRoot } from './project-location';
import { startSessionDashboard } from './dashboard';
import {
  drainBanners,
  dropThread,
  fleetCounts,
  initialFleet,
  pauseThread,
  pausedThreads,
  resumeThread,
  settleThread,
  spawnThread,
  type FleetState,
} from './fleet';

const execFileAsync = promisify(execFile);

/** Options parsed from argv on the no-arg interactive path. */
export interface InteractiveSessionOptions {
  /** `--continue`: resume the most recent session in this repo. */
  continue?: boolean;
  /** `--resume <id>`: resume a specific session by id. */
  resume?: string;
}

/**
 * Parses the no-arg interactive path's manual flags from a full `argv`
 * (`[node, script, ...args]`). Returns the {@link InteractiveSessionOptions}
 * when the args are ONLY the interactive flags (`--continue`/`-c`,
 * `--resume <id>`), or `null` when any other token is present (a subcommand or
 * unknown flag) so the caller defers to Commander. No Commander subcommands are
 * added — this is the only place these flags are recognised.
 */
export function parseInteractiveArgs(argv: string[]): InteractiveSessionOptions | null {
  const rest = argv.slice(2);
  const options: InteractiveSessionOptions = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--continue' || arg === '-c') {
      options.continue = true;
    } else if (arg === '--resume') {
      const id = rest[i + 1];
      if (id === undefined) {
        return null; // malformed → let Commander handle it (prints help)
      }
      options.resume = id;
      i += 1;
    } else if (arg !== undefined && arg.startsWith('--resume=')) {
      options.resume = arg.slice('--resume='.length);
    } else {
      return null; // a subcommand or unknown flag → defer to Commander
    }
  }
  return options;
}

/** Cached per-session context (computed once at session start). */
interface SessionRuntime {
  repoRoot: string;
  config: ExcaliburConfig;
  model: string;
  /** Session autonomy level — governs every turn's role + approvals. */
  autonomyLevel: AutonomyLevel;
  store: SessionStore;
  session: LocalSession;
  /** Running cost sum, in cents, across the session's assistant turns. */
  costCents: number;
  /** Session approval policy (auto-accept + per-tool "always") — minimum friction. */
  approvals: ApprovalState;
  /** Background agent threads (the `/bg` fleet); banners drained before each prompt. */
  fleet: FleetState;
  /** Active self-contained custom agent for the session (`/agent <name>`); null = none (P1.7b). */
  activeAgent: CustomAgent | null;
  /** AO8-4 — set on REPL teardown so a late background callback (chain / supervisor)
   * never spawns a new thread into a closing session. */
  shuttingDown: boolean;
  /**
   * In-flight background auto-compaction (fired after a turn, awaited before the
   * next turn builds its seed). Lets compaction overlap with the user's typing so
   * it's effectively invisible. Undefined when none is pending.
   */
  pendingCompaction?: Promise<void>;
  /**
   * Peak prompt tokens the provider reported on the last turn — the REAL context
   * size, used for an accurate compaction trigger + the `ctx%` status indicator
   * (falls back to a chars/4 estimate when unknown, e.g. the offline mock).
   */
  lastInputTokens?: number;
  /**
   * INT-1 — the interrupt handler for a message typed WHILE a turn streams, set
   * once per interactive session and threaded into each turn's AgentTurnDeps so
   * the live rail's typing channel reaches the session lifecycle (abort / parallel
   * thread / queued foreground turn). Undefined outside the interactive REPL.
   */
  onInterrupt?: AgentTurnDeps['onInterrupt'];
}

/**
 * The interactive conversational session (`excalibur` with no args → a
 * readline REPL). The shell is MODEL-FIRST: a natural-language line is handed
 * straight to the real agentic loop ({@link runAgentTurn}) — the MODEL decides
 * whether to answer (read tools) or to edit/run (write tools), governed by the
 * session's autonomy level. There is no keyword classifier choosing intent.
 *
 * Only the two STRUCTURAL forms are parsed locally: a leading `/` slash command
 * and a leading `!` shell passthrough. Tool approvals are inline ([y/N]),
 * Ctrl-C cancels the in-flight turn, and everything (redacted) is recorded to a
 * `SessionStore` transcript. Mock is the zero-config default: with the mock
 * provider the loop returns a templated text answer (graceful offline demo);
 * with a real provider it does full agentic work.
 *
 * Returns the process exit code (0 on a graceful close).
 */
export async function runInteractiveSession(
  deps: CliDeps,
  options: InteractiveSessionOptions = {},
): Promise<number> {
  // Smart project-location resolution (proactive): if you launch `excalibur`
  // somewhere that isn't a project — your home dir, `/`, or an ambiguous folder
  // — and you actually want to START a project, create one (`mkdir`+`git init`+
  // `chdir`) instead of scaffolding into `~`. Only on an interactive TTY; a
  // non-interactive run keeps the cwd unchanged.
  let repoRoot = deps.cwd();
  if (deps.ui.isInteractive() && deps.ui.isOutputTty()) {
    repoRoot = await resolveProjectRoot(deps, repoRoot, repoSelectKeymap(deps));
  }
  // Repo analysis warms the context engine (ISD scanning) once per session, and
  // feeds the zero-config onboarding below. Kick it off WITHOUT awaiting so it
  // overlaps with the onboarding prompts (it can be slow on a large repo);
  // onboarding awaits it just before it writes the init plan.
  const analysisPromise = analyzeRepository(repoRoot, {
    homeDir: deps.homeDir(),
    includeUserGlobal: deps.includeUserGlobal,
  });
  // PROACTIVE zero-config onboarding (core-onboarding-ux): on the first
  // `excalibur` run in a repo (no .excalibur/ or no model configured) auto-run
  // the model wizard + write a minimal .excalibur/ BEFORE the welcome — so the
  // welcome shows the real configured model. The user never has to discover
  // `init`/`models setup`. No-op on a non-TTY or an already-set-up repo.
  await maybeAutoOnboard(deps, repoRoot, analysisPromise);
  let config = loadConfigContext(repoRoot).config;
  // Extensions can bring MCP servers (EXT-6); merge them into the session config
  // so the native agent loop connects them too (the repo's own mcp.servers wins).
  // Best-effort — a failing extension load never blocks the session.
  try {
    config = withExtensionMcpServers(config, await createExtensionHost(repoRoot));
  } catch {
    /* extensions are additive; never block the shell on a load failure */
  }
  const gateway = loadGatewayContext(repoRoot);
  const store = new SessionStore(repoRoot);

  // User-defined custom slash commands (P1.6): markdown templates under
  // .excalibur/commands/ (+ ~/.config/excalibur/commands/ when user-global is on).
  // Loaded once; consulted only as a fallthrough so built-ins always win.
  const customCommands = loadCustomCommands({
    repoRoot,
    homeDir: deps.homeDir(),
    includeGlobal: deps.includeUserGlobal,
  });

  // PROACTIVE startup context: read the repo's state BEFORE creating a new
  // session (so `latest` is the PRIOR one) — last activity, active plan, memory.
  // Surfaced after the welcome; the user never needs `--continue`.
  const startup = buildStartupContext(deps.t, repoRoot, store);

  // Resume / continue / create the session. A resumed session must belong to
  // THIS repo: a session dir copied in from elsewhere would misalign every
  // relative path and artifact reference, so we refuse it rather than silently
  // operate on the wrong tree.
  let session: LocalSession;
  if (options.resume !== undefined) {
    session = store.getSession(options.resume);
    if (session.metadata.repoRoot !== repoRoot) {
      throw new CliUsageError(
        deps.t('repl.resume-wrong-repo', {
          id: session.id,
          repoRoot: session.metadata.repoRoot,
        }),
      );
    }
    replayTranscript(deps, store, session);
  } else if (options.continue === true) {
    const latest = store.latestSession();
    if (latest !== null && latest.metadata.repoRoot === repoRoot) {
      session = latest;
      replayTranscript(deps, store, session);
    } else {
      session = store.createSession({ title: 'Interactive session', repoRoot });
    }
  } else {
    session = store.createSession({ title: 'Interactive session', repoRoot });
  }
  // A resumed session is active again until it is closed.
  if (session.metadata.status === 'closed') {
    session = store.updateMetadata(session.id, { status: 'active' });
  }

  const runtime: SessionRuntime = {
    repoRoot,
    config,
    model: gateway.providerName,
    // Default to L4 (full agentic) when the config doesn't pin one — onboarding
    // writes autonomy.default: 4, and pre-existing configs without it get it too.
    autonomyLevel: (config.autonomy?.default ?? 4) as AutonomyLevel,
    store,
    session,
    costCents: 0,
    // Resolve the saved auto-accept preference; the prompt below sets it the
    // first time (so future sessions never ask).
    approvals: { auto: config.approvals?.auto === true },
    fleet: initialFleet(),
    activeAgent: null,
    shuttingDown: false,
  };

  // Welcome banner (two-column frame + cyberpunk sword) + status line.
  deps.ui.write(renderWelcome(buildWelcomeContext(deps, repoRoot, runtime.model)));
  deps.ui.write();

  // Paint the terminal's native cursor in the sword-blue accent for the whole
  // session (restored in the finally below) — the thing you type against glows
  // the brand colour. Only on a real output TTY; honours NO_COLOR via the helper.
  if (deps.ui.isOutputTty()) {
    setCursorAccent(process.stdout);
  }

  // Proactively surface what Excalibur already knows about this repo, and OFFER
  // to resume the last session (no `--continue` needed). Only when this is a
  // fresh launch (not an explicit --resume/--continue) on a real TTY.
  for (const line of startup.lines) {
    deps.ui.info(line);
  }
  if (startup.lines.length > 0) {
    deps.ui.write();
  }
  if (
    options.resume === undefined &&
    options.continue !== true &&
    startup.latest !== null &&
    startup.latest.id !== session.id &&
    deps.ui.isInteractive() &&
    deps.ui.isOutputTty()
  ) {
    const turns = store
      .readTranscript(startup.latest.id)
      .filter((turn) => turn.kind === 'message').length;
    const resume = await deps.ui.confirm(deps.t('repl.resume-offer', { turns }), {
      defaultYes: true,
    });
    if (resume) {
      runtime.session =
        startup.latest.metadata.status === 'closed'
          ? store.updateMetadata(startup.latest.id, { status: 'active' })
          : startup.latest;
      replayTranscript(deps, store, runtime.session);
    }
  }

  // Minimum-friction auto-accept: ask ONCE (when never chosen) whether Excalibur
  // may edit/run without prompting, then PERSIST the answer so it never asks
  // again — in this session or future ones. Blocked paths stay hard-denied.
  if (config.approvals?.auto === undefined && deps.ui.isInteractive() && deps.ui.isOutputTty()) {
    const allow = await deps.ui.confirm(deps.t('repl.auto-setup-prompt'), { defaultYes: true });
    runtime.approvals.auto = allow;
    try {
      setAutoApprove(repoRoot, allow);
    } catch {
      // Persisting the preference is best-effort; the session still honours it.
    }
    deps.ui.info(deps.t(allow ? 'repl.auto-enabled' : 'repl.auto-disabled'));
    deps.ui.write();
  }

  printStatusLine(deps, runtime);

  // Auto-start the read-only web dashboard alongside the shell (onboarding UX):
  // the local server comes up in the background so runs/events are watchable in
  // a browser without discovering `excalibur serve`. Torn down in the finally
  // below. No-op on a non-TTY, when disabled, or if every candidate port is busy.
  const dashboard = await startSessionDashboard(deps, repoRoot, config);

  const history = store.loadPromptHistory().slice().reverse(); // readline wants newest-first
  // Has the user submitted anything yet this session? Drives the CONTEXTUAL
  // placeholder (a first-run invitation vs a follow-up hint) — re-evaluated each
  // prompt by the editor.
  let interacted = false;
  const editor = deps.ui.openLineEditor({
    history,
    // The `/` command menu (filters as you type) + a dim CONTEXTUAL placeholder.
    commands: slashCommands(deps.t),
    placeholder: () => deps.t(interacted ? 'repl.ph.next' : 'repl.ph.start'),
  });
  // LLM intent classifier (multi-language), resolved ONCE. undefined → no fast
  // model / opted out → the shell stays model-first (everything a plain turn).
  const classifyIntent = buildIntentClassifier(deps, runtime);

  // First Ctrl-C (or ESC, on the raw editor) during an in-flight turn cancels
  // it; a second Ctrl-C at an empty prompt exits. We track an AbortController
  // per in-flight dispatch, and tell the editor when a turn is active so the raw
  // editor can route ESC / queue typed input.
  let inFlight: AbortController | null = null;
  let sawSigintAtPrompt = false;
  // Background `/bg` threads: id → its AbortController (cancelled on session exit).
  const bgControllers = new Map<string, AbortController>();

  /** Begins a turn: a fresh AbortController + the editor enters turn-mode. */
  const beginTurn = (): AbortController => {
    inFlight = new AbortController();
    editor.setTurnActive(true);
    return inFlight;
  };
  /** Ends a turn: clears the controller + the editor leaves turn-mode. */
  const endTurn = (): void => {
    inFlight = null;
    editor.setTurnActive(false);
  };
  /** Cancels the in-flight turn (shared by Ctrl-C and ESC); true when one ran. */
  const cancelInFlight = (): boolean => {
    if (inFlight === null) {
      return false;
    }
    inFlight.abort();
    endTurn();
    deps.ui.write();
    deps.ui.info(deps.t('repl.cancelled-back-to-prompt'));
    return true;
  };

  const offSigint = editor.onSigint(() => {
    if (cancelInFlight()) {
      return;
    }
    if (sawSigintAtPrompt) {
      editor.close();
    } else {
      sawSigintAtPrompt = true;
      deps.ui.write();
      deps.ui.info(deps.t('repl.ctrl-c-again'));
    }
  });
  // ESC (raw editor only; a no-op on the line editor) cancels an in-flight turn.
  const offEscape = editor.onEscape(() => {
    cancelInFlight();
  });

  // INT-1 — the interrupt channel. A message the user types WHILE a turn streams
  // is triaged (steer/quick/new/stop/answer) and routed WITHOUT losing the work:
  // a steer folds in after, an independent request runs as a parallel `/bg`
  // thread, a conflicting one pauses + switches, a stop aborts. Foreground
  // re-dispatches are queued here and drained after the current turn unwinds (the
  // REPL is single-threaded), so there is never a concurrency race on the editor.
  const interruptModel = buildInterruptModel(deps, runtime);
  const pendingForeground: { text: string; reaskAfter?: string }[] = [];
  if (interruptModel !== undefined) {
    runtime.onInterrupt = async (input, control): Promise<void> => {
      const ops: InterruptOps = {
        say: (t) => control.say(t),
        abort: () => control.abort(),
        pauseCurrent: () => {
          // Park the interrupted work as a first-class resumable thread (INT-5).
          const title =
            control.currentWork.length > 56
              ? `${control.currentWork.slice(0, 55)}…`
              : control.currentWork;
          runtime.fleet = pauseThread(
            runtime.fleet,
            generateId('paused'),
            title,
            control.currentWork,
          );
        },
        runParallel: (t) => launchBgThread(deps, runtime, t, bgControllers),
        queueForeground: (t, o) => {
          pendingForeground.push({
            text: t,
            ...(o.reaskAfter !== undefined ? { reaskAfter: o.reaskAfter } : {}),
          });
          if (o.abortCurrent) control.abort();
        },
        recordMessage: (t) =>
          runtime.store.appendTurn(runtime.session.id, { role: 'user', kind: 'message', text: t }),
      };
      const outcome = await decideInterrupt(
        input,
        {
          currentWork: control.currentWork,
          awaitingAnswer: control.awaitingAnswer,
          ...(control.pendingQuestion !== undefined
            ? { pendingQuestion: control.pendingQuestion }
            : {}),
          touchedPaths: control.touchedPaths,
        },
        interruptModel,
      );
      executeInterrupt(outcome, input, ops, control.pendingQuestion);
    };
  }

  /** Drains foreground interrupts (folded steer / pause+switch) queued during the
   * just-finished turn — they run automatically, in order, then re-ask anything
   * the interrupted turn was waiting on. */
  const drainForegroundInterrupts = async (): Promise<void> => {
    while (pendingForeground.length > 0 && !runtime.shuttingDown) {
      const next = pendingForeground.shift()!;
      const fctrl = beginTurn();
      try {
        const seed = await sessionSeedSettled(runtime);
        await dispatchAgentTurn(deps, runtime, next.text, fctrl.signal, seed);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        deps.ui.error(reason);
      } finally {
        endTurn();
      }
      if (next.reaskAfter !== undefined && next.reaskAfter.length > 0) {
        // Never lose the question the interrupted turn was awaiting.
        deps.ui.info(deps.t('repl.interrupt-reask', { question: next.reaskAfter }));
      }
    }
  };

  /** INT-5 — after the switch work finishes, OFFER to resume each paused (interrupted)
   * thread (default yes). Accept → re-dispatch its task; decline → dismiss it. The
   * "pause the current work, do the new, THEN resume" promise, made explicit. */
  const offerResumePaused = async (): Promise<void> => {
    if (runtime.shuttingDown) {
      return;
    }
    for (const thread of pausedThreads(runtime.fleet)) {
      let resume = true;
      if (deps.ui.isInteractive()) {
        deps.ui.write();
        resume = await deps.ui.confirm(
          deps.t('repl.interrupt-resume-offer', { title: thread.title }),
          { defaultYes: true },
        );
      }
      if (!resume) {
        runtime.fleet = dropThread(runtime.fleet, thread.id); // dismissed — still recorded in history
        continue;
      }
      runtime.fleet = resumeThread(runtime.fleet, thread.id);
      deps.ui.info(deps.t('repl.interrupt-resuming', { title: thread.title }));
      const fctrl = beginTurn();
      try {
        await dispatchAgentTurn(
          deps,
          runtime,
          thread.resumeTask ?? thread.title,
          fctrl.signal,
          await sessionSeedSettled(runtime),
        );
      } catch (error) {
        deps.ui.error(error instanceof Error ? error.message : String(error));
      } finally {
        endTurn();
      }
      runtime.fleet = dropThread(runtime.fleet, thread.id); // resumed + done
    }
  };

  /** The full post-turn interrupt aftermath: run queued foreground work (folds /
   * switches), then offer to resume paused work — and drain anything that resume
   * itself queued. Bounded (one extra drain pass; deeper nesting stays in /threads). */
  const settleInterruptAftermath = async (): Promise<void> => {
    await drainForegroundInterrupts();
    await offerResumePaused();
    if (pendingForeground.length > 0) {
      await drainForegroundInterrupts();
    }
  };

  try {
    for (;;) {
      // Surface any finished background-thread banners above the prompt (one-shot).
      const drained = drainBanners(runtime.fleet);
      if (drained.banners.length > 0) {
        runtime.fleet = drained.state;
        deps.ui.write();
        for (const banner of drained.banners) {
          deps.ui.info(banner);
        }
        printStatusLine(deps, runtime);
      }
      // While a background run is live, show an accent rule above the prompt with
      // its title cutting the line (CC-style "what's running" indicator).
      const live = runtime.fleet.threads.filter(
        (thread) => thread.status === 'running' || thread.status === 'blocked',
      );
      if (live.length > 0) {
        const label =
          live.length === 1 ? (live[0]?.title ?? '') : deps.t('repl.bg-active', { n: live.length });
        deps.ui.write(renderRunRule(label, process.stdout.columns ?? 80));
      }
      const line = await editor.question(accent('› '));
      if (line === null) {
        break; // EOF / Ctrl-D
      }
      if (line.trim().length > 0) {
        interacted = true; // next prompt shows the follow-up placeholder
      }
      // Esc-Esc at the prompt opens the rewind time-machine over the latest run
      // (same flow as `/rewind`, no id). The scrubber drives its own question()
      // reads; a missing-runs error is surfaced without breaking the session.
      if (line === REWIND_SENTINEL) {
        try {
          await handleReplayCommand(deps, runtime, undefined, (prompt) => editor.question(prompt));
        } catch (error) {
          deps.ui.error(error instanceof Error ? error.message : String(error));
        }
        printStatusLine(deps, runtime);
        continue;
      }
      // ↓ on the empty live line opens the Session Log (same flow as `/log`).
      if (line === LOG_SENTINEL) {
        await handleLogCommand(deps, runtime, (prompt) => editor.question(prompt));
        printStatusLine(deps, runtime);
        continue;
      }
      const text = line.trim();
      sawSigintAtPrompt = false;

      if (text.length === 0) {
        printStatusLine(deps, runtime);
        continue;
      }

      const input = parseStructuralInput(text);

      // Built-in slash commands are handled inline (never recorded as turns),
      // EXCEPT /plan and /discovery which run (recorded) work. The whole block
      // is wrapped so a handler throw (e.g. a corrupt run's events.jsonl while
      // resolving `/changes`/`/fork`, or a disk write fault) returns to the
      // prompt instead of crashing the session — mirroring the NL path below.
      if (input.kind === 'command') {
        try {
          if (input.name === 'plan') {
            await handlePlanCommand(deps, runtime, input.argv.join(' '), () => beginTurn());
            endTurn();
            printStatusLine(deps, runtime);
            continue;
          }
          if (input.name === 'discovery') {
            await handleDiscoveryCommand(deps, runtime, input.argv.join(' '));
            printStatusLine(deps, runtime);
            continue;
          }
          if (input.name === 'rewind' || input.name === 'replay') {
            await handleReplayCommand(deps, runtime, input.argv[0], (prompt) =>
              editor.question(prompt),
            );
            printStatusLine(deps, runtime);
            continue;
          }
          if (input.name === 'changes') {
            handleChangesCommand(deps, input.argv[0]);
            printStatusLine(deps, runtime);
            continue;
          }
          if (input.name === 'log') {
            await handleLogCommand(deps, runtime, (prompt) => editor.question(prompt));
            printStatusLine(deps, runtime);
            continue;
          }
          if (input.name === 'fork') {
            const ctrl = beginTurn();
            const execution = await handleForkCommand(deps, runtime, input.argv, ctrl.signal);
            endTurn();
            if (execution !== null) {
              await recordAssistantTurn(deps, runtime, execution);
            }
            printStatusLine(deps, runtime);
            continue;
          }
          if (input.name === 'undo') {
            await handleUndoCommand(deps);
            printStatusLine(deps, runtime);
            continue;
          }
          if (input.name === 'auto') {
            // Toggle (or set on/off) the session auto-accept mode + persist it,
            // so future sessions honour the choice without asking.
            const arg = (input.argv[0] ?? '').toLowerCase();
            const next = arg === 'on' ? true : arg === 'off' ? false : !runtime.approvals.auto;
            runtime.approvals.auto = next;
            try {
              setAutoApprove(runtime.repoRoot, next);
            } catch {
              /* persisting is best-effort */
            }
            deps.ui.info(deps.t(next ? 'repl.auto-on' : 'repl.auto-off'));
            printStatusLine(deps, runtime);
            continue;
          }
          if (input.name === 'compact') {
            await runCompaction(deps, runtime, { manual: true });
            printStatusLine(deps, runtime);
            continue;
          }
          if (input.name === 'remember') {
            handleRememberCommand(deps, runtime, input.argv.join(' '));
            printStatusLine(deps, runtime);
            continue;
          }
          if (input.name === 'goal') {
            await handleGoalCommand(deps, runtime, input.argv.join(' '), beginTurn, endTurn);
            printStatusLine(deps, runtime);
            continue;
          }
          if (input.name === 'loop') {
            await handleLoopCommand(deps, runtime, input.argv, beginTurn, endTurn);
            printStatusLine(deps, runtime);
            continue;
          }
          if (input.name === 'swarm') {
            const ctrl = beginTurn();
            try {
              await handleSwarmCommand(deps, runtime, input.argv.join(' '), ctrl.signal);
            } finally {
              endTurn();
            }
            printStatusLine(deps, runtime);
            continue;
          }
          if (input.name === 'explore') {
            const ctrl = beginTurn();
            try {
              await handleExploreCommand(deps, runtime, input.argv.join(' '), ctrl.signal);
            } finally {
              endTurn();
            }
            printStatusLine(deps, runtime);
            continue;
          }
          if (input.name === 'bg') {
            void handleBgCommand(deps, runtime, input.argv.join(' '), bgControllers);
            printStatusLine(deps, runtime);
            continue;
          }
          if (input.name === 'threads') {
            handleThreadsCommand(deps, runtime);
            printStatusLine(deps, runtime);
            continue;
          }
          if (input.name === 'models') {
            await handleModelsCommand(deps, runtime);
            printStatusLine(deps, runtime);
            continue;
          }
          if (input.name === 'agent') {
            handleAgentCommand(deps, runtime, input.argv);
            printStatusLine(deps, runtime);
            continue;
          }
          // User-defined custom slash command (P1.6) — fallthrough AFTER built-ins
          // so a user command can never shadow one. Expand its template ($ARGUMENTS,
          // $1, !`cmd`, @file) and run it as a normal turn.
          const custom = customCommands.get(input.name);
          if (custom !== undefined) {
            const expanded = await expandCustomCommand(custom.body, {
              argv: input.argv,
              repoRoot: runtime.repoRoot,
            });
            const safe = redactSecrets(`/${input.name} ${input.argv.join(' ')}`.trim());
            store.appendPromptHistory(safe);
            store.appendTurn(session.id, { role: 'user', kind: 'message', text: safe });
            const ctrl = beginTurn();
            await dispatchAgentTurn(
              deps,
              runtime,
              expanded,
              ctrl.signal,
              await sessionSeedSettled(runtime),
            );
            endTurn();
            printStatusLine(deps, runtime);
            continue;
          }
          const result = handleSlashCommand(deps, runtime, input.name);
          if (result === 'exit') {
            break;
          }
          continue;
        } catch (error) {
          endTurn();
          deps.ui.error(error instanceof Error ? error.message : String(error));
          printStatusLine(deps, runtime);
          continue;
        }
      }

      // Record the user turn + remember the prompt for history. The raw `text`
      // still drives dispatch (the user typed it on purpose), but everything
      // PERSISTED to disk is redacted so a pasted key never lands in
      // transcript.jsonl or the history file.
      // Prior conversation (compacted) for cross-turn memory — captured BEFORE
      // recording this turn's user message, so it is context only, not the
      // current prompt. Empty on the first turn → an independent turn as before.
      const seed = await sessionSeedSettled(runtime);

      const safeText = redactSecrets(text);
      store.appendPromptHistory(safeText);
      store.appendTurn(session.id, { role: 'user', kind: 'message', text: safeText });

      if (input.kind === 'shell') {
        await runShellPassthrough(deps, runtime, input.command);
        printStatusLine(deps, runtime);
        continue;
      }

      // Natural-language turn → INTENT-ROUTED by the LLM classifier (core,
      // MULTI-LANGUAGE — never keyword/regex). It detects plan / swarm / bg /
      // research / goal vs a plain turn, via the FAST model. No fast model,
      // mock, non-interactive, read-only level, or EXCALIBUR_ROUTER=off →
      // `chat` (a plain model-first turn). swarm/bg/goal are OFFERED; plan
      // carries its own gate (skipped under auto = zero-prompts).
      const decision: TurnDecision =
        classifyIntent === undefined
          ? { intent: 'chat', confidence: 'high' }
          : await withThinking(deps, understandingPhrases(deps.t), () =>
              classifyTurnDecision(
                text,
                {
                  interactive: deps.ui.isInteractive(),
                  mock: runtime.model === 'mock',
                  level: runtime.autonomyLevel,
                },
                classifyIntent,
              ),
            );
      const intent = decision.intent;

      // AO3d-2 — PROACTIVE 3-WAY POSTURE: the heavy routes (goal/bg/swarm/research/
      // plan) are EXECUTION SHAPES Excalibur picks itself, never commands the user
      // types. `decidePosture` derives act / narrate-and-act / ask from the
      // classifier's CONFIDENCE + the shape's RISK + the autonomy level — so safe,
      // confident routes just run, high-impact ones announce-while-running under
      // full autonomy, and only the unsure or irreversible ones ask. No flag.
      const posture = (i: TurnIntent): RoutePosture =>
        decidePosture({
          risk: riskOfShape(i),
          confidence: decision.confidence,
          level: runtime.autonomyLevel,
          autoApprove: runtime.approvals.auto,
        });
      const acceptRoute = async (
        offerKey: string,
        autoNoticeKey: string,
        vars?: Record<string, string | number>,
      ): Promise<boolean> => {
        const p = posture(intent);
        if (p === 'ask') {
          return deps.ui.confirm(deps.t(offerKey, vars), { defaultYes: true });
        }
        deps.ui.info(deps.t(autoNoticeKey, vars));
        if (p === 'narrate') {
          deps.ui.info(deps.t('repl.route-narrate-hint'));
        }
        return true;
      };

      let asGoal = false;
      if (intent === 'goal') {
        asGoal = await acceptRoute('repl.goal-offer', 'repl.route-goal-auto', {
          max: goalMaxIterations(runtime.config),
        });
      }
      if (
        !asGoal &&
        intent === 'bg' &&
        (await acceptRoute('repl.route-bg-offer', 'repl.route-bg-auto'))
      ) {
        void handleBgCommand(deps, runtime, text, bgControllers);
        printStatusLine(deps, runtime);
        continue;
      }
      const asSwarm =
        !asGoal &&
        intent === 'swarm' &&
        (await acceptRoute('repl.route-swarm-offer', 'repl.route-swarm-auto'));
      const asResearch =
        !asGoal &&
        !asSwarm &&
        intent === 'research' &&
        (await acceptRoute('repl.route-research-offer', 'repl.route-research-auto'));
      // AO5 — best-of-N reached by NL (no command): "try a few approaches and pick
      // the best". High-risk (a cost amplifier) so the posture ASKS unless full
      // autonomy. Only meaningful in a git repo (lanes need worktrees).
      const asExplore =
        !asGoal &&
        !asSwarm &&
        !asResearch &&
        intent === 'explore' &&
        getGitInfo(runtime.repoRoot).isRepo &&
        (await acceptRoute('repl.route-explore-offer', 'repl.route-explore-auto'));
      // A plan ACTS (auto-orchestrate) unless the posture says ask → the
      // deliberate plan → approve → execute gate.
      const planActs = intent === 'plan' && posture('plan') !== 'ask';

      const ctrl = beginTurn();
      try {
        if (asGoal) {
          await executeGoalLoop(deps, runtime, text, seed, ctrl.signal);
        } else if (asResearch) {
          // F7: the native multi-agent research pipeline (search → fetch →
          // verify → cited synthesis).
          await runResearchFlow(deps, text, {});
        } else if (asExplore) {
          // AO5 best-of-N via NL: N candidate approaches in parallel → judge → apply winner.
          const g = loadGatewayContext(runtime.repoRoot);
          await runExploreFlow(
            deps,
            runtime.repoRoot,
            text,
            { gateway: g.gateway, providerName: g.providerName, config: runtime.config },
            { signal: ctrl.signal },
          );
        } else if (asSwarm || planActs) {
          // AO2/AO3d-2 — an ACCEPTED build (swarm-intent accepted, or a plan the
          // posture runs) is AUTO-ORCHESTRATED: decompose → DERIVE the shape
          // (≥2 independent workstreams → an auto-sized parallel swarm, else one
          // focused run). The user already decided at the posture gate — no
          // further prompts; the planner and parallelizer are fused.
          await dispatchAutoBuild(deps, runtime, text, ctrl.signal, seed);
        } else if (intent === 'orchestration') {
          // AO6 Pillar 5 — NL control of an EXISTING orchestration (any language):
          // view the chronogram, or pause/resume it. No command needed; the
          // dashboard buttons + `orchestration` command are escape hatches.
          const runId = latestOrchestrationRunId(runtime.repoRoot);
          if (runId === null) {
            deps.ui.info(deps.t('orchestration.none'));
          } else {
            const action =
              classifyIntent === undefined
                ? 'show'
                : await classifyOrchestrationAction(text, classifyIntent, ctrl.signal);
            if (action === 'show') {
              renderChronogramView(deps, runtime.repoRoot, runId, false);
            } else {
              const paused = action === 'pause';
              setOrchestrationPaused(runtime.repoRoot, runId, paused, new Date().toISOString());
              deps.ui.info(
                deps.t(paused ? 'orchestration.pause-set' : 'orchestration.resume-set', {
                  id: runId,
                }),
              );
            }
          }
        } else if (intent === 'scope') {
          // AO9-3 — NL-routed read-only "Understand-first" scope (any language):
          // "what's involved in X" / "scope this" / "qué implica" → map the
          // subsystems, built-vs-missing and risks WITHOUT building. Low-risk
          // (read-only by construction) so it just runs — no posture gate.
          await runScopeFlow(deps, text, { signal: ctrl.signal });
        } else if (intent === 'schedule') {
          // AO8-4 — NL-routed scheduling (any language): "every morning run the
          // test sweep" → a persisted ScheduledJob (the OSS analog of cron /
          // ScheduleWakeup), no `schedule add` command needed. If the cadence
          // can't be understood, fall through to a normal turn so the model can
          // still respond / clarify.
          const handled = await dispatchSchedule(
            deps,
            runtime,
            text,
            posture('schedule'),
            ctrl.signal,
          );
          if (!handled) {
            await dispatchAgentTurn(deps, runtime, text, ctrl.signal, seed);
          }
        } else if (intent === 'mission' && posture('mission') !== 'ask') {
          // The meta-orchestrator: interpret the goal, auto-author the capability
          // plan, and drive it autonomously (M8). The proactive route for big work —
          // only when the posture grants it (full autonomy); otherwise it asks below.
          await runMissionTurn(text, {
            deps,
            repoRoot: runtime.repoRoot,
            config: runtime.config,
            autonomyLevel: runtime.autonomyLevel,
            approvals: runtime.approvals,
            signal: ctrl.signal,
          });
        } else if (intent === 'plan' || intent === 'mission') {
          // Plan, posture ASK → the deliberate plan → approve → execute gate.
          await dispatchPlan(deps, runtime, text, ctrl.signal, seed);
        } else {
          // chat · research-declined → a direct model-first turn (the model still
          // has web_search/web_fetch/research tools).
          await dispatchAgentTurn(deps, runtime, text, ctrl.signal, seed);
        }
      } catch (error) {
        endTurn();
        const reason = error instanceof Error ? error.message : String(error);
        deps.ui.error(reason);
        store.appendTurn(session.id, { role: 'system', kind: 'status', text: `error: ${reason}` });
        await settleInterruptAftermath(); // a steer/switch queued before the error still runs
        printStatusLine(deps, runtime);
        continue;
      }
      endTurn();
      // INT-1/INT-5 — run any foreground interrupt (folded steer / pause+switch)
      // queued while this turn streamed, then offer to resume the paused work.
      await settleInterruptAftermath();
      printStatusLine(deps, runtime);
    }
  } finally {
    // AO8-4 — stop any late background callback (chain / supervisor) from spawning
    // a NEW thread into the closing session, then cancel the in-flight ones.
    runtime.shuttingDown = true;
    offSigint();
    offEscape();
    editor.close();
    dashboard?.stop();
    // Restore the user's terminal cursor colour (paired with setCursorAccent).
    if (deps.ui.isOutputTty()) {
      resetCursorColor(process.stdout);
    }
    // Cancel any still-running background threads so the process can exit cleanly.
    for (const ctrl of bgControllers.values()) {
      ctrl.abort();
    }
  }

  closeSession(deps, runtime);
  return 0;
}

/**
 * The LLM intent classifier backing conversational routing — multi-language, via
 * the FAST/cheap model (low latency; reasoning pinned off). Returns undefined
 * when there is no real model OR no distinct fast model (so a slow-only or
 * mock/unconfigured setup never pays a per-turn classification penalty → the
 * shell stays model-first and routes everything as a plain turn). Mirrors the
 * ghost suggester: short timeout + tiny output; a slow model simply times out.
 */
function buildIntentClassifier(deps: CliDeps, runtime: SessionRuntime): IntentModel | undefined {
  if (deps.env['EXCALIBUR_ROUTER'] === 'off') {
    return undefined;
  }
  const gateway = loadGatewayContext(runtime.repoRoot);
  if (!gateway.configured) {
    return undefined; // no model at all → can't classify
  }
  // The intelligence layer (intent routing → scope / plan-shaping / mission) must
  // NEVER be silently off just because no SEPARATE fast model is paired: fall back
  // to the DEFAULT model so single-model setups still get routed. A reasoning
  // default burns output tokens "thinking" before the label, so the 6-token cap
  // that suits a fast model returns empty — give it headroom + time on fallback.
  const provider = gateway.cheapProviderName ?? gateway.providerName;
  const providerCfg = (
    gateway.providers.providers as Record<
      string,
      { type?: string; capabilities?: { reasoning?: boolean } }
    >
  )[provider];
  if (providerCfg?.type === 'mock') {
    return undefined;
  }
  const reasoning = providerCfg?.capabilities?.reasoning === true;
  return async (prompt: string, signal?: AbortSignal): Promise<string> => {
    const output = await gateway.gateway.chat({
      provider,
      messages: [{ role: 'user', content: redactSecrets(prompt) }],
      // A reasoning fallback needs room to emit the label AFTER thinking (6 tokens
      // → empty); verify-scope-routing confirms kimi-k2.7-code routes at this
      // budget with reasoning pinned minimal. The fast paired model stays snappy.
      maxTokens: reasoning ? 256 : 6,
      timeoutMs: reasoning ? 10000 : 2500,
      ...(reasoning ? { reasoningEffort: 'minimal' as const } : {}),
      metadata: { kind: 'intent' },
      ...(signal !== undefined ? { signal } : {}),
    });
    return output.content;
  };
}

/**
 * The model that backs the interrupt triage (INT-1) — the same FAST/cheap model
 * as the intent classifier, but with a more generous token budget: the triage
 * answers in two words, yet the independence judge needs room for "OVERLAP — <a
 * one-sentence reason>" (a 6-token cap truncates the reason mid-word and a
 * reasoning model needs headroom). Returns undefined when there is no real/fast
 * model (the channel then simply never arms — a typed line does nothing).
 */
function buildInterruptModel(deps: CliDeps, runtime: SessionRuntime): InterruptModel | undefined {
  const gateway = loadGatewayContext(runtime.repoRoot);
  if (!gateway.configured) {
    return undefined;
  }
  // Same rule as the intent classifier: fall back to the default model so the
  // interrupt channel is never silently dead when no fast model is paired.
  const provider = gateway.cheapProviderName ?? gateway.providerName;
  const providerCfg = (
    gateway.providers.providers as Record<
      string,
      { type?: string; capabilities?: { reasoning?: boolean } }
    >
  )[provider];
  if (providerCfg?.type === 'mock') {
    return undefined;
  }
  const reasoning = providerCfg?.capabilities?.reasoning === true;
  return async (prompt: string, signal?: AbortSignal): Promise<string> => {
    const output = await gateway.gateway.chat({
      provider,
      messages: [{ role: 'user', content: redactSecrets(prompt) }],
      maxTokens: reasoning ? 256 : 48,
      timeoutMs: reasoning ? 10000 : 4000,
      ...(reasoning ? { reasoningEffort: 'minimal' as const } : {}),
      metadata: { kind: 'intent' },
      ...(signal !== undefined ? { signal } : {}),
    });
    return output.content;
  };
}

/**
 * PLAN-SHAPING (CC/Cursor-style co-creation): before a build/plan turn runs,
 * propose LLM-derived clarifying questions + a MULTI-SELECT list of related
 * developments (high-confidence pre-checked) the user toggles into the plan; fold
 * the choices + answers into the task text. It surfaces ONLY when it genuinely
 * helps — a LARGE plan, an UNCLEAR design, or real OPTIONAL developments — and
 * stays SILENT for small or already-clear tasks (the {@link shouldSurfacePlanShape}
 * gate). SKIPS entirely when there is no fast model, a mock, or a non-interactive
 * stdin (returns the text as-is, so scripted / --yes / bg paths are unchanged).
 * Best-effort: any fault → original text.
 */
async function shapePlan(
  deps: CliDeps,
  runtime: SessionRuntime,
  text: string,
  signal: AbortSignal,
): Promise<string> {
  if (
    deps.env['EXCALIBUR_ROUTER'] === 'off' ||
    !deps.ui.isInteractive() ||
    runtime.model === 'mock'
  ) {
    return text;
  }
  // Best-effort: a malformed/unreadable providers.yaml makes loadGatewayContext
  // throw — that must NOT break the plan turn, so fall back to the original text.
  let gateway: ReturnType<typeof loadGatewayContext>;
  let provider: string | undefined;
  try {
    gateway = loadGatewayContext(runtime.repoRoot);
    provider = gateway.cheapProviderName ?? gateway.providerName;
  } catch {
    return text;
  }
  if (!gateway.configured || provider == null) {
    return text;
  }
  const providerType = (gateway.providers.providers as Record<string, { type?: string }>)[provider]
    ?.type;
  if (providerType === 'mock') {
    return text;
  }
  // A dedicated adapter — the intent classifier caps maxTokens at 6 (one word),
  // far too small for the shaping JSON. A generous ceiling (a cap, not a target)
  // keeps a verbose-language reply (e.g. Spanish, 3 Qs + 6 detailed recs) from
  // truncating mid-JSON → unparseable → silently no shaping.
  const model = async (prompt: string, sig?: AbortSignal): Promise<string> => {
    const output = await gateway.gateway.chat({
      provider,
      messages: [{ role: 'user', content: redactSecrets(prompt) }],
      maxTokens: 1200,
      timeoutMs: 20000,
      metadata: { kind: 'plan-shape' },
      ...(sig !== undefined ? { signal: sig } : {}),
    });
    return output.content;
  };

  let shape: PlanShape;
  try {
    shape = await withThinking(deps, planningPhrases(deps.t), () =>
      planShape(
        text,
        { interactive: true, mock: false, level: runtime.autonomyLevel },
        model,
        signal,
      ),
    );
  } catch {
    return text;
  }
  if (signal.aborted) return text; // ESC during shaping → back to prompt, no interactive UI
  // The gate: only interrupt the user when shaping genuinely helps (large plan,
  // unclear design, or real optional scope). Small / clear-medium tasks proceed
  // silently — planning is unchanged.
  if (!shouldSurfacePlanShape(shape)) {
    return text;
  }

  // AO9-3 — PROACTIVE auto-scope: for a LARGE plan, FIRST map the relevant code
  // read-only (what exists vs what's missing, risks) and RE-SHAPE grounded in it,
  // so the questions + recommendations reference reality instead of guessing. Only
  // the big tasks pay (the gate is inside autoScopeForPlanning, reusing the
  // complexity we already graded). Best-effort + opt-out via EXCALIBUR_AUTO_SCOPE=off.
  if (deps.env['EXCALIBUR_AUTO_SCOPE'] !== 'off') {
    const scoped = await autoScopeForPlanning(runtime.repoRoot, gateway, text, {
      complexity: shape.complexity,
      signal,
      onProgress: (phase, subsystem) => {
        if (phase === 'decompose') deps.ui.info(deps.t('repl.scope-prescan'));
        else if (phase === 'explore')
          deps.ui.info(deps.t('scope.explored', { subsystem: subsystem ?? '' }));
      },
    });
    if (scoped !== null) {
      deps.ui.info(
        deps.t('repl.scope-grounded', { subsystems: String(scoped.map.subsystems.length) }),
      );
      const grounded = await withThinking(deps, planningPhrases(deps.t), () =>
        planShape(
          text,
          { interactive: true, mock: false, level: runtime.autonomyLevel },
          model,
          signal,
          scoped.markdown,
        ),
      );
      // Keep the grounded shape only when it still has something to act on.
      if (grounded.recommendations.length > 0 || grounded.questions.length > 0) {
        shape = grounded;
      }
    }
  }
  // ESC during the (multi-second) scope fan-out must short-circuit BEFORE the
  // interactive multiSelect/ask, mirroring dispatchSchedule's signal.aborted guard.
  if (signal.aborted) return text;

  const extras: string[] = [];
  if (shape.recommendations.length > 0) {
    deps.ui.info(deps.t('repl.plan-shape-intro'));
    const choices = shape.recommendations.map((r) => ({
      label: r.title,
      ...(r.detail.length > 0 ? { hint: r.detail } : {}),
    }));
    const preselected = shape.recommendations
      .map((r, i) => (r.recommended ? i : -1))
      .filter((i) => i >= 0);
    const chosen = await deps.ui.multiSelect(deps.t('repl.plan-shape-prompt'), choices, {
      preselected,
      navHint: deps.t('repl.plan-shape-nav'),
    });
    for (const i of chosen) {
      const r = shape.recommendations[i];
      if (r !== undefined) {
        extras.push(`- ${r.title}${r.detail.length > 0 ? ` (${r.detail})` : ''}`);
      }
    }
  }
  // Asymmetric: only interrupt to ASK when the plan is large or the design is
  // unclear. A clear medium task that surfaced for its recommendations alone
  // never gets interrogated (the user just toggled the pre-checked extras).
  const answers: string[] = [];
  if (shouldAskPlanQuestions(shape)) {
    for (const q of shape.questions) {
      const a = await deps.ui.ask(q, { defaultAnswer: '' });
      if (a.trim().length > 0) {
        answers.push(`- ${q} → ${a.trim()}`);
      }
    }
  }
  if (extras.length === 0 && answers.length === 0) {
    return text;
  }
  let refined = text;
  if (extras.length > 0) {
    refined += `\n\nAlso include in the plan:\n${extras.join('\n')}`;
  }
  if (answers.length > 0) {
    refined += `\n\nClarifications (from the user):\n${answers.join('\n')}`;
  }
  return refined;
}

/** Builds the agent-turn deps from the session runtime. */
function agentTurnDeps(deps: CliDeps, runtime: SessionRuntime, signal: AbortSignal): AgentTurnDeps {
  const gateway = loadGatewayContext(runtime.repoRoot);
  const adapter = resolveAgentAdapter(runtime.config);
  // The native loop runs through the gateway, so a real provider must be
  // configured (refuse with setup guidance rather than drive a mock). A
  // custom-command passthrough does its OWN inference (it drives a vendor CLI
  // that holds the auth), so a subscription-only user with no providers.yaml can
  // still run — skip the model guard for it.
  if (agentUsesGateway(runtime.config)) {
    requireConfiguredModel(gateway, deps.t);
  }
  return {
    deps,
    repoRoot: runtime.repoRoot,
    config: runtime.config,
    gateway: gateway.gateway,
    providerName: gateway.providerName,
    autonomyLevel: runtime.autonomyLevel,
    approvals: runtime.approvals,
    adapter,
    signal,
    // Active custom agent (P1.7b /agent): its persona/model/sampling/guardrails
    // override this turn's defaults. Maps CustomAgent → the turn-deps override shape.
    ...(runtime.activeAgent !== null ? { agent: agentTurnOverride(runtime.activeAgent) } : {}),
    // INT-1 — the interrupt handler (set once per interactive session), so a
    // message typed while this turn streams is triaged + routed live.
    ...(runtime.onInterrupt !== undefined ? { onInterrupt: runtime.onInterrupt } : {}),
  };
}

/** Maps a {@link CustomAgent} onto the agent-turn override shape (P1.7b). */
function agentTurnOverride(a: CustomAgent): NonNullable<AgentTurnDeps['agent']> {
  return {
    name: a.name,
    systemPrompt: a.systemPrompt,
    ...(a.role !== undefined ? { role: a.role } : {}),
    ...(a.model !== undefined ? { model: a.model } : {}),
    ...(a.provider !== undefined ? { provider: a.provider } : {}),
    ...(a.temperature !== undefined ? { temperature: a.temperature } : {}),
    ...(a.tools !== undefined ? { allowedTools: a.tools } : {}),
    ...(a.permissions !== undefined ? { permissions: a.permissions } : {}),
  };
}

/** Records an assistant turn + accumulates cost from an agent-turn result. */
async function recordAssistantTurn(
  deps: CliDeps,
  runtime: SessionRuntime,
  result: AgentTurnResult,
): Promise<void> {
  if (result.costCents !== null) {
    runtime.costCents += result.costCents;
  }
  runtime.store.appendTurn(runtime.session.id, {
    role: 'assistant',
    kind: 'message',
    text: result.text,
    // Record the PROVIDER identity (e.g. `mock`) — the same name the StatusLine
    // shows — for a consistent session-level model attribution.
    model: runtime.model,
    costCents: result.costCents,
    artifactRef: result.runId,
  });
  if (typeof result.inputTokens === 'number') {
    runtime.lastInputTokens = result.inputTokens; // real context size for the gate + ctx%
  }
  // Auto-compact in the BACKGROUND (best-effort; respects `compaction.enabled`).
  // Fire-and-forget + silent so it overlaps with the user typing the next prompt;
  // `sessionSeedSettled()` awaits it before the next turn builds its seed, so the
  // user effectively never waits for compaction (near-invisible).
  runtime.pendingCompaction = runCompaction(deps, runtime, { manual: false, silent: true }).catch(
    () => undefined,
  );
}

/**
 * `/remember <text>` — captures a project-memory node (Knowledge Compounding,
 * M2.6). Subject paths are inferred from path-like mentions so a future run
 * touching those files is primed with it. Best-effort; never throws into the loop.
 */
function handleRememberCommand(deps: CliDeps, runtime: SessionRuntime, text: string): void {
  const statement = text.trim();
  if (statement.length === 0) {
    deps.ui.warn(deps.t('repl.remember-usage'));
    return;
  }
  const subjectPaths = [...new Set(statement.match(/[\w.-]+(?:\/[\w.-]+)+/g) ?? [])];
  try {
    const node = new MemoryStore(runtime.repoRoot).capture({
      type: 'decision',
      statement,
      subjectPaths,
      sourceRunId: runtime.session.id,
    });
    const detail = `${node.type}${subjectPaths.length > 0 ? ` · ${subjectPaths.join(', ')}` : ''}`;
    // Knowledge compounding made VISIBLE: a corroborating capture reinforces an
    // existing memory (evidenceCount > 1) rather than duplicating it.
    if (node.evidenceCount > 1) {
      deps.ui.success(deps.t('repl.remember-reinforced', { detail, count: node.evidenceCount }));
    } else {
      deps.ui.success(deps.t('repl.remember-saved', { detail }));
    }
  } catch (error) {
    deps.ui.warn(
      deps.t('repl.remember-failed', {
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** The active main model's context window (tokens), or a safe default. */
function compactionContextWindow(repoRoot: string, providerName: string): number {
  try {
    const gateway = loadGatewayContext(repoRoot);
    const config = (gateway.providers.providers as Record<string, { contextWindow?: number }>)[
      providerName
    ];
    return config?.contextWindow ?? 128_000;
  } catch {
    return 128_000;
  }
}

/**
 * Builds the M2 real-model summarizer, or `undefined` when there is no real
 * model to summarize with (no gateway, or a mock provider) — in which case the
 * caller uses the offline deterministic default. The summary becomes the
 * session's DURABLE context, so it defaults to the main (quality) model; only
 * `summarizerModel: 'cheap'` opts into the fast pairing model for cost/latency.
 */
function buildCompactionSummarizer(
  runtime: SessionRuntime,
  config: typeof DEFAULT_COMPACTION_CONFIG,
): AsyncSummarizer | undefined {
  try {
    const gateway = loadGatewayContext(runtime.repoRoot);
    if (!gateway.configured) {
      return undefined;
    }
    const provider =
      config.summarizerModel === 'cheap'
        ? (gateway.cheapProviderName ?? gateway.providerName)
        : gateway.providerName;
    const providerType = (gateway.providers.providers as Record<string, { type?: string }>)[
      provider
    ]?.type;
    if (providerType === 'mock') {
      return undefined; // the mock is a test double — use the offline summarizer
    }
    return createModelSummarizer({
      chat: gateway.gateway,
      provider,
      locale: sessionLocale(runtime),
      pruneToolOutputs: config.pruneToolOutputs,
    });
  } catch {
    return undefined; // any resolution failure → offline default (never blocks)
  }
}

/**
 * The session's spoken locale for generated prose (summaries). The summarizer
 * already speaks `en`/`es`; until the i18n milestone adds a spoken-language
 * config + auto-detection (plan §"Idioma"), this is `en`. Wire that setting here
 * when it lands — the rest of the path is locale-ready.
 */
function sessionLocale(_runtime: SessionRuntime): string {
  return 'en';
}

/**
 * Compacts the session transcript (plan §"Compactación de contexto"). Manual
 * `/compact` forces it now (bypassing the budget gate); the automatic path fires
 * only when the transcript exceeds the model's usable budget. The summary is
 * produced by the real `cheap` model (M2) with a graceful fallback to the
 * deterministic offline summarizer if it is unavailable or fails. Best-effort: a
 * failure never breaks the session. The {@link CompactionRecord} is persisted to
 * the session's compaction index for replay/reinjection.
 */
async function runCompaction(
  deps: CliDeps,
  runtime: SessionRuntime,
  opts: { manual: boolean; force?: boolean; silent?: boolean },
): Promise<void> {
  const config = runtime.config.compaction ?? DEFAULT_COMPACTION_CONFIG;
  // `force` (manual /compact, or the reactive overflow path) bypasses the budget
  // gate; the proactive auto path still respects the master switch + budget.
  const force = opts.manual || opts.force === true;
  if (!force && !config.enabled) {
    return; // the automatic path respects the master switch
  }
  try {
    const turns = runtime.store.readTranscript(runtime.session.id);
    const contextWindow = compactionContextWindow(runtime.repoRoot, runtime.model);
    // The on-disk transcript is lossless (it keeps every turn, even ones already
    // folded into a prior summary). Gating the AUTOMATIC path on that raw total
    // would re-compact the same prefix on every turn once it first goes over
    // budget. Gate instead on the EFFECTIVE context we'd send — preferring the
    // provider's REAL last prompt-token count over the chars/4 estimate.
    if (!force) {
      const latest = runtime.store.latestCompaction(runtime.session.id);
      const estimated = buildSessionSeed(turns, latest).reduce(
        (sum, message) => sum + estimateTokens(message.content),
        0,
      );
      const effectiveTokens = Math.max(runtime.lastInputTokens ?? 0, estimated);
      if (effectiveTokens <= contextWindow - config.reserveTokens) {
        return; // effective context is within budget — no compaction churn
      }
    }
    const summarizer = buildCompactionSummarizer(runtime, config);
    // Manual /compact is blocking → show a self-erasing spinner (TTY-only); the
    // auto/reactive paths run silently in the background.
    const spinner = opts.manual ? deps.ui.createSpinner() : null;
    spinner?.start(() => deps.t('repl.compacting'));
    let record;
    try {
      if (summarizer !== undefined) {
        try {
          record = await compactSessionAsync(turns, {
            config,
            contextWindow,
            model: runtime.model,
            force,
            locale: sessionLocale(runtime),
            summarize: summarizer,
          });
        } catch {
          // The real-model summary failed (network/timeout) — fall back to the
          // deterministic offline summarizer so compaction still happens.
          record = compactSession(turns, {
            config,
            contextWindow,
            model: runtime.model,
            force,
          });
        }
      } else {
        record = compactSession(turns, {
          config,
          contextWindow,
          model: runtime.model,
          force,
        });
      }
    } finally {
      spinner?.stop();
    }
    if (record === null) {
      if (opts.manual) {
        deps.ui.info(deps.t('repl.compact-nothing'));
      }
      return;
    }
    runtime.store.appendCompaction(runtime.session.id, record);
    // Reflect the freed context immediately in the ctx% indicator.
    runtime.lastInputTokens = record.tokensAfter;
    if (!opts.silent) {
      const n = record.details.summarizedEntryIds.length;
      deps.ui.info(
        opts.manual
          ? deps.t('repl.compacted-manual', {
              n,
              before: record.tokensBefore,
              after: record.tokensAfter,
            })
          : deps.t('repl.compacted-auto', {
              n,
              before: record.tokensBefore,
              after: record.tokensAfter,
            }),
      );
    }
  } catch (error) {
    if (opts.manual) {
      deps.ui.warn(
        deps.t('repl.compaction-failed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

/**
 * The compacted prior conversation to seed the next turn (cross-turn memory):
 * the persisted transcript reduced through the latest compaction record. Empty
 * when there is no prior context. This is the reinjection consumer (the turn
 * loop already supports `seedMessages`); it also makes a RESUMED session carry
 * its history, since the seed is rebuilt from the persisted transcript.
 */
function sessionSeed(runtime: SessionRuntime): ChatMessage[] {
  try {
    const turns = runtime.store.readTranscript(runtime.session.id);
    return buildSessionSeed(turns, runtime.store.latestCompaction(runtime.session.id));
  } catch {
    return []; // context memory is best-effort — never block a turn
  }
}

/**
 * Awaits any in-flight background compaction, THEN builds the seed — so the next
 * turn always reflects the latest compaction without the user ever waiting for it
 * synchronously (it ran while they were reading/typing).
 */
async function sessionSeedSettled(runtime: SessionRuntime): Promise<ChatMessage[]> {
  if (runtime.pendingCompaction !== undefined) {
    await runtime.pendingCompaction;
    runtime.pendingCompaction = undefined;
  }
  return sessionSeed(runtime);
}

/** Dispatches a direct model-driven turn (the default NL path). */
async function dispatchAgentTurn(
  deps: CliDeps,
  runtime: SessionRuntime,
  text: string,
  signal: AbortSignal,
  seed: ChatMessage[],
): Promise<void> {
  let result;
  try {
    result = await runAgentTurn(agentTurnDeps(deps, runtime, signal), text, seed);
  } catch (error) {
    // Reactive safety net: the prompt overflowed the context window (the
    // heuristic under-counted, or a single turn grew huge). Force a compaction
    // and retry the turn ONCE with the freed-up seed — never on an abort.
    if (signal.aborted || !isContextOverflowError(error)) {
      throw error;
    }
    deps.ui.info(deps.t('repl.compacting-overflow'));
    await runCompaction(deps, runtime, { manual: false, force: true, silent: true });
    result = await runAgentTurn(
      agentTurnDeps(deps, runtime, signal),
      text,
      await sessionSeedSettled(runtime),
    );
  }
  await recordAssistantTurn(deps, runtime, result);
}

/** Dispatches an auto plan-mode turn (plan → gate → execute). */
async function dispatchPlan(
  deps: CliDeps,
  runtime: SessionRuntime,
  text: string,
  signal: AbortSignal,
  seed: ChatMessage[],
): Promise<void> {
  // Plan-shaping: co-create the scope (clarifying Qs + multi-select recommendations)
  // before the plan is generated; the choices refine the plan prompt.
  const shaped = await shapePlan(deps, runtime, text, signal);
  const plan = await runPlanTurn(agentTurnDeps(deps, runtime, signal), shaped, seed);
  runtime.store.appendTurn(runtime.session.id, {
    role: 'assistant',
    kind: 'message',
    text: plan.planText,
    model: runtime.model,
    artifactRef: plan.planRunId,
  });
  if (plan.execution !== null) {
    await recordAssistantTurn(deps, runtime, plan.execution);
  }
}

/**
 * AO2 — the auto-orchestrator. Under autonomy a build is executed WITHOUT the
 * user choosing or sizing the shape: Excalibur decomposes the task and DERIVES
 * it. ≥2 INDEPENDENT workstreams (and a git repo, needed for isolated worktrees)
 * → a parallel, auto-sized swarm that merges + applies; otherwise a single
 * focused run. This is where the planner and the parallelizer are fused — one
 * decision, no command. Any probe failure falls back to the sequential run (the
 * directive is to always do the work, never dead-end).
 */
async function dispatchAutoBuild(
  deps: CliDeps,
  runtime: SessionRuntime,
  text: string,
  signal: AbortSignal,
  seed: ChatMessage[],
): Promise<void> {
  // Plan-shaping: co-create the scope (clarifying Qs + multi-select recommendations)
  // before decomposing/building; the choices refine the task that gets decomposed.
  text = await shapePlan(deps, runtime, text, signal);
  const isRepo = getGitInfo(runtime.repoRoot).isRepo;
  if (isRepo) {
    try {
      const gateway = loadGatewayContext(runtime.repoRoot);
      requireConfiguredModel(gateway, deps.t); // a swarm of mock agents is pointless
      const subtasks = await withThinking(deps, decomposePhrases(deps.t), () =>
        decomposeTask(gateway.gateway, text, {
          provider: gateway.providerName,
          signal,
        }),
      );
      if (chooseBuildShape({ isRepo, subtaskCount: subtasks.length }) === 'swarm') {
        deps.ui.info(deps.t('repl.auto-build-parallel', { count: subtasks.length }));
        await runSwarmFlow(
          deps,
          runtime.repoRoot,
          text,
          {
            gateway: gateway.gateway,
            providerName: gateway.providerName,
            config: runtime.config,
          },
          { subtasks, yes: true, signal },
        );
        // AO6 Pillar 5 — proactively surface that this orchestration is now a
        // first-class, viewable + pausable object (NL or dashboard), no command.
        deps.ui.info(deps.t('repl.orchestration-hint'));
        return;
      }
    } catch (error) {
      deps.ui.warn(error instanceof Error ? error.message : String(error));
    }
  }
  deps.ui.info(deps.t('repl.auto-build-sequential'));
  await dispatchAgentTurn(deps, runtime, text, signal, seed);

  // AO4f-2 — give the SEQUENTIAL auto-build the same adversarial review the swarm
  // path gets (AO4f-1). The turn already applied as it went (no merge gate to
  // revert), so this is a proportional, best-effort post-review that SURFACES
  // high-severity findings rather than reverting. Opt-in via verifyMerge; never
  // on the mock; never blocks.
  if (runtime.config.orchestration?.verifyMerge === true && runtime.model !== 'mock') {
    try {
      const gateway = loadGatewayContext(runtime.repoRoot);
      const diff = getLocalDiff(runtime.repoRoot);
      if (diff.trim().length > 0) {
        const out = await runProportionalMesh(
          { gateway: gateway.gateway, providerName: gateway.providerName, config: runtime.config },
          diff,
        );
        if (out !== null) {
          deps.ui.info(deps.t('repl.auto-build-review', { lenses: out.lenses }));
          for (const issue of out.result.issues) {
            const where = issue.file !== undefined ? `${issue.file} — ` : '';
            deps.ui.write(`  [${issue.severity.toUpperCase()}] ${where}${issue.problem}`);
          }
          if (out.result.blocked) {
            deps.ui.warn(deps.t('repl.auto-build-review-high'));
          }
        }
      }
    } catch {
      /* best-effort post-review — never fail the build on a flaky jury */
    }
  }
}

/**
 * `/swarm <task>` — fan a task out to REAL parallel agents from inside the
 * shell: a model decomposes it into independent subtasks, the allocator sizes
 * the swarm, and live lanes light up as each agent works in its own worktree
 * (the same flow as `excalibur swarm`, reused). ESC cancels the in-flight swarm.
 */
async function handleSwarmCommand(
  deps: CliDeps,
  runtime: SessionRuntime,
  task: string,
  signal: AbortSignal,
): Promise<void> {
  if (task.trim().length === 0) {
    deps.ui.warn(deps.t('repl.swarm-usage'));
    return;
  }
  if (!getGitInfo(runtime.repoRoot).isRepo) {
    deps.ui.error(deps.t('swarm.needsGitRepo'));
    return;
  }
  const gateway = loadGatewayContext(runtime.repoRoot);
  requireConfiguredModel(gateway, deps.t); // a swarm of mock agents is pointless
  runtime.store.appendPromptHistory(`/swarm ${redactSecrets(task)}`);
  await runSwarmFlow(
    deps,
    runtime.repoRoot,
    task,
    { gateway: gateway.gateway, providerName: gateway.providerName, config: runtime.config },
    { signal },
  );
}

/**
 * `/explore <task>` — best-of-N (AO5): fans the SAME task to N candidate agents
 * in isolated worktrees, a model judge picks the winner, and ONLY the winner is
 * applied (ground-truth gated when a test command is configured). The parallel
 * counterpart to the single-agent `run --explore` workflow.
 */
async function handleExploreCommand(
  deps: CliDeps,
  runtime: SessionRuntime,
  task: string,
  signal: AbortSignal,
): Promise<void> {
  if (task.trim().length === 0) {
    deps.ui.warn(deps.t('repl.explore-usage'));
    return;
  }
  if (!getGitInfo(runtime.repoRoot).isRepo) {
    deps.ui.error(deps.t('swarm.needsGitRepo'));
    return;
  }
  const gateway = loadGatewayContext(runtime.repoRoot);
  requireConfiguredModel(gateway, deps.t); // best-of-N over the mock is pointless
  runtime.store.appendPromptHistory(`/explore ${redactSecrets(task)}`);
  await runExploreFlow(
    deps,
    runtime.repoRoot,
    task,
    { gateway: gateway.gateway, providerName: gateway.providerName, config: runtime.config },
    { signal },
  );
}

/**
 * `/bg <task>` — launches a background agent thread. It runs QUIETLY to its own
 * recorded run (no live rail, auto-approved) so the prompt stays free; when it
 * finishes a one-shot banner is raised above the next prompt. Blocked paths stay
 * hard-denied at the tool layer. Never throws to the caller (fire-and-forget).
 */
async function handleBgCommand(
  deps: CliDeps,
  runtime: SessionRuntime,
  task: string,
  controllers: Map<string, AbortController>,
): Promise<void> {
  const trimmed = task.trim();
  if (trimmed.length === 0) {
    deps.ui.warn(deps.t('repl.bg-usage'));
    return;
  }
  runtime.store.appendPromptHistory(`/bg ${redactSecrets(trimmed)}`);
  // AO8-1 — split a chained request ("build X and then run the tests") into the
  // primary task + an auto-follow-up; best-effort (no model → the whole thing).
  const chain = await parseBgChain(deps, runtime, trimmed);
  launchBgThread(deps, runtime, chain.task, controllers, chain.followUp ?? undefined);
}

/** Upper bound on enabled NL-created scheduled jobs — bounds runaway accumulation
 * from a burst of natural-language turns or a misroute (the explicit `schedule add`
 * command is unbounded by design; this guards only the auto-triggerable path). */
const MAX_SCHEDULED_JOBS = 50;

/**
 * AO8-4 — NL → scheduled job. Extracts a cadence + task from a free-form recurring
 * request (any language) and persists a {@link ScheduledJob} (the OSS analog of
 * cron / ScheduleWakeup). Uses the CHEAP model (a JSON-sized token budget) for the
 * extraction — NOT the 6-token intent classifier, whose cap would truncate the
 * `{cadence,task}` object mid-string to unparseable. Honours the `schedule`-route
 * {@link RoutePosture}: at full autonomy it just creates it (the success line shows
 * exactly what was scheduled); otherwise it asks, showing the EXACT parsed schedule
 * first. Returns false ONLY when no usable cadence/task could be extracted (the
 * caller falls back to a normal turn so the model can still respond / clarify);
 * true once handled (scheduled, declined, duplicate, capped, cancelled, or the
 * cadence was unparseable). Never throws.
 */
async function dispatchSchedule(
  deps: CliDeps,
  runtime: SessionRuntime,
  text: string,
  posture: RoutePosture,
  signal: AbortSignal,
): Promise<boolean> {
  // Extraction needs a JSON-sized budget. The intent classifier caps at 6 tokens
  // (one word) — far too small; a reasoning model would spend the whole budget
  // thinking and emit an empty/truncated object. Use the cheap model with the
  // generous SCHEDULE_EXTRACT_MAXTOKENS ceiling (mirrors shapePlan), gated
  // identically (router off / non-interactive / mock / unconfigured → null).
  const classify = buildCheapModel(deps, runtime, {
    maxTokens: SCHEDULE_EXTRACT_MAXTOKENS,
    kind: 'schedule-extract',
  });
  if (classify === null) {
    return false; // no usable model to extract with → let a normal turn handle it
  }
  const extracted = await classifyScheduleExtraction(text, classify, signal);
  // A mid-extraction ESC aborts the signal; the cancel banner already printed, so
  // treat it as TERMINAL — don't let the caller launch a fresh agent turn.
  if (signal.aborted) {
    return true;
  }
  if (extracted === null) {
    return false;
  }
  const spec = parseScheduleSpec(extracted.cadence);
  if (spec === null) {
    // Understood the SCHEDULE intent but not the cadence — say so + point at the
    // explicit command rather than guessing a cadence.
    deps.ui.warn(deps.t('repl.schedule-unparsed', { cadence: extracted.cadence }));
    return true;
  }
  // Never persist secrets to .excalibur/schedules.json — the task is re-sent to the
  // model on EVERY fire, so redact the model-echoed task before it touches disk.
  const safeTask = redactSecrets(extracted.task);
  const store = new ScheduleStore(runtime.repoRoot);
  const existing = store.list();
  // Dedup: re-phrasing the same recurring request must not pile up duplicate jobs.
  if (
    existing.some(
      (j) => j.enabled && j.task === safeTask && describeSpec(j.spec) === describeSpec(spec),
    )
  ) {
    deps.ui.info(deps.t('repl.schedule-duplicate', { spec: describeSpec(spec) }));
    return true;
  }
  // Cap: bound runaway accumulation from a burst of NL turns / a misclassification.
  if (existing.filter((j) => j.enabled).length >= MAX_SCHEDULED_JOBS) {
    deps.ui.warn(deps.t('repl.schedule-cap', { max: MAX_SCHEDULED_JOBS }));
    return true;
  }
  // Posture: a `schedule` is medium-risk (commits to FUTURE autonomous runs) — at
  // full autonomy it just creates it (the success line below shows exactly what was
  // scheduled), otherwise it asks, showing the EXACT parsed schedule first.
  if (posture === 'ask') {
    const ok = await deps.ui.confirm(
      deps.t('repl.schedule-confirm', { spec: describeSpec(spec), task: safeTask }),
      { defaultYes: true },
    );
    if (!ok) {
      deps.ui.info(deps.t('repl.schedule-declined'));
      return true;
    }
  }
  const now = Date.now();
  const job: ScheduledJob = {
    id: generateId('sched'),
    task: safeTask,
    spec,
    createdAtMs: now,
    lastRunMs: null,
    nextRunMs: nextRun(spec, now),
    enabled: true,
  };
  try {
    store.add(job);
  } catch (error) {
    deps.ui.error(error instanceof Error ? error.message : String(error));
    return true;
  }
  deps.ui.success(
    deps.t('repl.schedule-added', {
      spec: describeSpec(spec),
      task: safeTask,
      next: new Date(job.nextRunMs).toLocaleString(),
    }),
  );
  // Off by default: nothing fires unless the daemon (`schedule run`) or `serve` is alive.
  deps.ui.info(deps.t('repl.schedule-daemon-hint'));
  return true;
}

/**
 * Builds the cheap-model `classify` adapter used by the AO8 background reactions
 * (chain split + completion supervisor) and the NL-schedule extraction, or null when
 * there is no usable model (router off / non-interactive / mock / unconfigured).
 * Gated like {@link shapePlan}.
 *
 * `opts.maxTokens` is a CEILING, not a target — the default 400 suits the tiny
 * one-line reactions, but JSON extraction (schedule cadence/task) must pass a
 * GENEROUS budget so a reasoning model's thinking tokens + a verbose-language reply
 * never truncate the object mid-string (the same trap {@link shapePlan} guards with
 * its 1200 ceiling; the 6-token intent classifier is far too small for structured
 * output). Never reuse the intent classifier for JSON.
 */
function buildCheapModel(
  deps: CliDeps,
  runtime: SessionRuntime,
  opts: { maxTokens?: number; kind?: string } = {},
): ((prompt: string, signal?: AbortSignal) => Promise<string>) | null {
  if (
    deps.env['EXCALIBUR_ROUTER'] === 'off' ||
    !deps.ui.isInteractive() ||
    runtime.model === 'mock'
  ) {
    return null;
  }
  let gateway: ReturnType<typeof loadGatewayContext>;
  let provider: string | undefined;
  try {
    gateway = loadGatewayContext(runtime.repoRoot);
    provider = gateway.cheapProviderName ?? gateway.providerName;
  } catch {
    return null;
  }
  if (!gateway.configured || provider == null) {
    return null;
  }
  const providerType = (gateway.providers.providers as Record<string, { type?: string }>)[provider]
    ?.type;
  if (providerType === 'mock') {
    return null;
  }
  return async (prompt: string, sig?: AbortSignal): Promise<string> => {
    const output = await gateway.gateway.chat({
      provider,
      messages: [{ role: 'user', content: redactSecrets(prompt) }],
      maxTokens: opts.maxTokens ?? 400,
      timeoutMs: 20000,
      metadata: { kind: opts.kind ?? 'bg-react' },
      ...(sig !== undefined ? { signal: sig } : {}),
    });
    return output.content;
  };
}

/** The JSON-extraction token ceiling for NL scheduling — generous so a reasoning
 * model's thinking + a verbose-language reply never truncate the {cadence,task}
 * object (mirrors {@link shapePlan}'s 1200). MUST stay ≥ what the calibration
 * harness `scripts/verify-schedule-routing.mjs` asserts the extractor needs. */
const SCHEDULE_EXTRACT_MAXTOKENS = 1200;

/** AO8-1 — splits a `/bg` request into {task, followUp}; best-effort → no chain. */
async function parseBgChain(
  deps: CliDeps,
  runtime: SessionRuntime,
  request: string,
): Promise<TaskChain> {
  const model = buildCheapModel(deps, runtime);
  if (model === null) {
    return { task: request, followUp: null };
  }
  try {
    return await parseChain(request, { interactive: true, mock: false }, model);
  } catch {
    return { task: request, followUp: null };
  }
}

/**
 * AO8-4 — anti-loop bound on AUTO-spawned background follow-ups (explicit chains +
 * supervisor continues combined). A supervisor whose follow-up itself re-supervises
 * could otherwise chain forever; this caps the depth (mirrors the AO5-5 ≤1-depth
 * swarm philosophy: bounded autonomous spawning, never a fork-bomb).
 */
const MAX_BG_CHAIN = 3;

/**
 * AO8-2/8-4 — when a bg thread settles with no explicit chain, a supervisor decides
 * the next action. PROACTIVE BY DEFAULT at full autonomy (the user already opted
 * into autonomy): it runs unless `orchestration.superviseBackground` is explicitly
 * `false`; below full autonomy it runs ONLY when that flag is `true`, and then it
 * OFFERS rather than auto-acts. A `continue` at full autonomy auto-dispatches the
 * follow-up (bounded by {@link MAX_BG_CHAIN}); `escalate` surfaces a note. Best-effort.
 */
function maybeSuperviseCompletion(
  deps: CliDeps,
  runtime: SessionRuntime,
  task: string,
  outcome: 'done' | 'failed',
  error: string | undefined,
  controllers: Map<string, AbortController>,
  chainDepth: number,
): void {
  // Proactive gate: ON at full autonomy unless explicitly disabled; opt-in (offer)
  // below. [[feedback-proactive-intelligent]] — don't make the user ask by command.
  const flag = runtime.config.orchestration?.superviseBackground;
  const enabled = flag === false ? false : runtime.approvals.auto || flag === true;
  if (!enabled) {
    return;
  }
  // Anti-loop: once the auto-spawned chain reaches the cap, stop reacting.
  if (chainDepth >= MAX_BG_CHAIN) {
    return;
  }
  const model = buildCheapModel(deps, runtime);
  if (model === null) {
    return;
  }
  void superviseCompletion(
    { task, outcome, ...(error !== undefined ? { error } : {}) },
    { interactive: true, mock: false },
    model,
  )
    .then((decision) => {
      if (decision.action === 'continue' && decision.followUp !== null) {
        const t =
          decision.followUp.length > 56 ? `${decision.followUp.slice(0, 55)}…` : decision.followUp;
        if (runtime.approvals.auto) {
          deps.ui.info(deps.t('repl.bg-supervise-continue', { title: t }));
          launchBgThread(deps, runtime, decision.followUp, controllers, undefined, chainDepth + 1);
        } else {
          deps.ui.info(deps.t('repl.bg-supervise-suggest', { title: t }));
        }
      } else if (decision.action === 'escalate' && decision.note !== null) {
        deps.ui.warn(deps.t('repl.bg-supervise-escalate', { note: decision.note }));
      }
    })
    .catch(() => {
      /* best-effort: a supervisor fault must never affect the session */
    });
}

/**
 * Spawns + runs ONE background thread. AO8-1: an optional `followUp` is
 * AUTO-DISPATCHED when this thread completes. AO8-4: `chainDepth` tracks how many
 * auto-spawned links deep this thread is, so the explicit chain + supervisor
 * continues are bounded by {@link MAX_BG_CHAIN} (never an unbounded background fork).
 */
function launchBgThread(
  deps: CliDeps,
  runtime: SessionRuntime,
  task: string,
  controllers: Map<string, AbortController>,
  followUp?: string,
  chainDepth = 0,
): void {
  // AO8-4 — never spawn into a closing session (a late chain/supervisor callback).
  if (runtime.shuttingDown) {
    return;
  }
  // Build the turn deps NOW so a misconfigured model fails HERE (visibly) rather
  // than inside the detached promise where the rejection would be swallowed.
  const ctrl = new AbortController();
  let base: AgentTurnDeps;
  try {
    base = agentTurnDeps(deps, runtime, ctrl.signal);
  } catch (error) {
    deps.ui.error(error instanceof Error ? error.message : String(error));
    return;
  }
  const id = generateId('bg');
  const title = task.length > 56 ? `${task.slice(0, 55)}…` : task;
  runtime.fleet = spawnThread(runtime.fleet, id, title, followUp);
  controllers.set(id, ctrl);
  deps.ui.info(deps.t('repl.bg-started', { title }));

  const bgDeps: AgentTurnDeps = { ...base, quiet: true, approvals: { auto: true } };
  void runAgentTurn(bgDeps, task)
    .then((result) => {
      if (result.costCents !== null) {
        runtime.costCents += result.costCents;
      }
      const pendingFollowUp = runtime.fleet.threads.find((t) => t.id === id)?.followUp;
      runtime.fleet = settleThread(runtime.fleet, id, 'done', deps.t('repl.bg-done', { title }));
      // AO8-1 — REACTION ON COMPLETION: the finished thread auto-dispatches its
      // explicit follow-up (no user command), bounded by MAX_BG_CHAIN (AO8-4).
      if (
        pendingFollowUp !== undefined &&
        pendingFollowUp.length > 0 &&
        chainDepth < MAX_BG_CHAIN
      ) {
        const fuTitle =
          pendingFollowUp.length > 56 ? `${pendingFollowUp.slice(0, 55)}…` : pendingFollowUp;
        deps.ui.info(deps.t('repl.bg-followup', { title: fuTitle }));
        launchBgThread(deps, runtime, pendingFollowUp, controllers, undefined, chainDepth + 1);
      } else if (pendingFollowUp === undefined || pendingFollowUp.length === 0) {
        // AO8-2/8-4 — no explicit chain → the supervisor decides next (proactive
        // at full autonomy), itself bounded by MAX_BG_CHAIN.
        maybeSuperviseCompletion(deps, runtime, task, 'done', undefined, controllers, chainDepth);
      }
    })
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      runtime.fleet = settleThread(
        runtime.fleet,
        id,
        'failed',
        deps.t('repl.bg-failed', { title, error: reason }),
      );
      // AO8-2/8-4 — a FAILED bg task is exactly when the supervisor adds value.
      maybeSuperviseCompletion(deps, runtime, task, 'failed', reason, controllers, chainDepth);
    })
    .finally(() => {
      controllers.delete(id);
    });
}

/** `/threads` — lists the background fleet (running + finished this session). */
function handleThreadsCommand(deps: CliDeps, runtime: SessionRuntime): void {
  if (runtime.fleet.threads.length === 0) {
    deps.ui.info(deps.t('repl.threads-none'));
    return;
  }
  const counts = fleetCounts(runtime.fleet);
  deps.ui.info(
    deps.t('repl.threads-header', {
      running: counts.running,
      paused: counts.paused,
      done: counts.done,
      failed: counts.failed,
    }),
  );
  for (const thread of runtime.fleet.threads) {
    const glyph =
      thread.status === 'done'
        ? pc.green('✓')
        : thread.status === 'failed'
          ? pc.red('✗')
          : thread.status === 'blocked'
            ? pc.yellow('⚑')
            : thread.status === 'paused'
              ? pc.yellow('⏸')
              : accent('◐');
    // A paused thread is interrupted work the user can come back to — flag it as
    // resumable so the surface is self-explanatory.
    const tail =
      thread.status === 'paused'
        ? pc.dim(`(${deps.t('repl.threads-paused-resumable')})`)
        : pc.dim(`(${thread.status})`);
    deps.ui.write(`  ${glyph} ${thread.title} ${tail}`);
  }
}

/**
 * `/plan <task>` — explicit plan-mode. Records the user turn, runs the plan
 * gate, and persists the plan (and execution, when approved).
 */
async function handlePlanCommand(
  deps: CliDeps,
  runtime: SessionRuntime,
  task: string,
  newController: () => AbortController,
): Promise<void> {
  if (task.trim().length === 0) {
    deps.ui.warn(deps.t('repl.plan-usage'));
    return;
  }
  const seed = sessionSeed(runtime); // prior context, before recording this turn
  const safeText = redactSecrets(task);
  runtime.store.appendPromptHistory(`/plan ${safeText}`);
  runtime.store.appendTurn(runtime.session.id, {
    role: 'user',
    kind: 'message',
    text: `/plan ${safeText}`,
  });
  const controller = newController();
  try {
    await dispatchPlan(deps, runtime, task, controller.signal, seed);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.ui.error(reason);
    runtime.store.appendTurn(runtime.session.id, {
      role: 'system',
      kind: 'status',
      text: `error: ${reason}`,
    });
  }
}

/** Default hard iteration cap for `/goal` (anti-runaway). Config-overridable. */
const DEFAULT_GOAL_MAX_ITERATIONS = 6;

/** The goal-loop iteration cap, from config (`orchestration.goalMaxIterations`)
 * or the default — never a hard-coded constant. */
export function goalMaxIterations(config: ExcaliburConfig): number {
  return config.orchestration?.goalMaxIterations ?? DEFAULT_GOAL_MAX_ITERATIONS;
}

/**
 * A deterministic "tests green" check for the goal loop, built from the repo's
 * configured test command. Delegates to the shared {@link runConfiguredCommandCheck}
 * so the goal-loop done-gate (AO3d) and the swarm's verified fan-in (AO4b) share
 * one runner. Kept as a named export for callers/tests.
 */
export const runConfiguredTestsCheck = runConfiguredCommandCheck;

/**
 * Runs the autonomous goal loop for an objective and reports + records the
 * outcome (each iteration is a real, gated, replayable agent turn; a cheap-model
 * evaluator decides done). The CALLER owns the turn lifecycle + recording the
 * user message — shared by the `/goal` command AND the NL goal offer.
 */
async function executeGoalLoop(
  deps: CliDeps,
  runtime: SessionRuntime,
  objective: string,
  seed: ChatMessage[],
  signal: AbortSignal,
): Promise<void> {
  const cheap = loadGatewayContext(runtime.repoRoot).cheapProviderName ?? undefined;
  const maxIterations = goalMaxIterations(runtime.config);
  // Ground-truth "done" gate: whenever a test command is configured, a green run
  // is authoritative — but ONLY for an iteration that actually mutated the tree
  // (a green run after a no-op iteration proves nothing). No per-language keyword
  // matching: the gate is armed by config + real changes, multilingual by design.
  const testRunner = runConfiguredTestsCheck(
    runtime.repoRoot,
    runtime.config.commands?.test,
    signal,
  );
  const deterministicCheck = testRunner
    ? async ({ mutated }: { mutated: boolean }) => (mutated ? testRunner() : undefined)
    : undefined;
  if (deterministicCheck !== undefined) {
    deps.ui.info(deps.t('repl.goal-done-gate', { test: runtime.config.commands?.test ?? '' }));
  }
  const result = await runGoalLoop(agentTurnDeps(deps, runtime, signal), objective, {
    maxIterations,
    signal,
    seed,
    ...(cheap !== undefined ? { evaluatorProvider: cheap } : {}),
    ...(deterministicCheck !== undefined ? { deterministicCheck } : {}),
    onIteration: (n, verdict) =>
      deps.ui.info(
        deps.t('repl.goal-iteration', {
          n,
          max: maxIterations,
          status: verdict.done ? deps.t('repl.goal-done') : deps.t('repl.goal-continue'),
          reason: verdict.reason,
        }),
      ),
  });
  const summary =
    result.status === 'done'
      ? deps.t('repl.goal-achieved', { iterations: result.iterations })
      : result.status === 'max-iterations'
        ? deps.t('repl.goal-max-iterations', {
            iterations: result.iterations,
            reason: result.lastReason ? ` — ${result.lastReason}` : '',
          })
        : result.status === 'aborted'
          ? deps.t('repl.goal-cancelled', { iterations: result.iterations })
          : deps.t('repl.goal-evaluator-unavailable', { iterations: result.iterations });
  deps.ui.info(summary);
  const last = result.results.at(-1);
  if (last !== undefined) {
    await recordAssistantTurn(deps, runtime, last);
  }
  runtime.store.appendTurn(runtime.session.id, { role: 'system', kind: 'status', text: summary });
}

/**
 * `/goal <objective>` — explicit autonomous loop. (A natural-language line with
 * an iterate-until-done signal also OFFERS this; see the NL dispatch.)
 */
async function handleGoalCommand(
  deps: CliDeps,
  runtime: SessionRuntime,
  goal: string,
  beginTurn: () => AbortController,
  endTurn: () => void,
): Promise<void> {
  const objective = goal.trim();
  if (objective.length === 0) {
    deps.ui.warn(deps.t('repl.goal-usage'));
    return;
  }
  const seed = sessionSeed(runtime); // prior context, before recording this turn
  const safe = redactSecrets(objective);
  runtime.store.appendPromptHistory(`/goal ${safe}`);
  runtime.store.appendTurn(runtime.session.id, {
    role: 'user',
    kind: 'message',
    text: `/goal ${safe}`,
  });

  const ctrl = beginTurn();
  try {
    await executeGoalLoop(deps, runtime, objective, seed, ctrl.signal);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.ui.error(reason);
    runtime.store.appendTurn(runtime.session.id, {
      role: 'system',
      kind: 'status',
      text: `error: ${reason}`,
    });
  } finally {
    endTurn();
  }
}

/** Defaults + cap for `/loop` (the periodic interval re-run). */
const LOOP_DEFAULT_EVERY_SECONDS = 60;
const LOOP_DEFAULT_TIMES = 10;
const LOOP_MAX_TIMES = 100;

/** Parses `/loop [--every <sec>] [--times <n>] <prompt>` (flags in any order). */
function parseLoopArgs(argv: string[]): { everySeconds: number; times: number; prompt: string } {
  let everySeconds = LOOP_DEFAULT_EVERY_SECONDS;
  let times = LOOP_DEFAULT_TIMES;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--every' && argv[i + 1] !== undefined) {
      const value = Number.parseInt(argv[(i += 1)] ?? '', 10);
      if (!Number.isNaN(value) && value >= 0) everySeconds = value;
    } else if (arg === '--times' && argv[i + 1] !== undefined) {
      const value = Number.parseInt(argv[(i += 1)] ?? '', 10);
      if (!Number.isNaN(value) && value >= 1) times = value;
    } else if (arg !== undefined) {
      rest.push(arg);
    }
  }
  return { everySeconds, times: Math.min(times, LOOP_MAX_TIMES), prompt: rest.join(' ') };
}

/**
 * `/loop [--every <sec>] [--times <n>] <prompt>` — the periodic interval loop.
 * Re-runs `<prompt>` as a gated agent turn every `--every` seconds (default 60),
 * up to `--times` (default 10, cap 100), until ESC. RECURRENCE, not completion —
 * for "watch/poll/retry this periodically" (vs `/goal`, which stops when done).
 */
async function handleLoopCommand(
  deps: CliDeps,
  runtime: SessionRuntime,
  argv: string[],
  beginTurn: () => AbortController,
  endTurn: () => void,
): Promise<void> {
  const { everySeconds, times, prompt } = parseLoopArgs(argv);
  if (prompt.trim().length === 0) {
    deps.ui.warn(deps.t('repl.loop-usage'));
    return;
  }
  const safe = redactSecrets(prompt);
  runtime.store.appendPromptHistory(`/loop ${safe}`);
  runtime.store.appendTurn(runtime.session.id, {
    role: 'user',
    kind: 'message',
    text: `/loop ${safe}`,
  });
  deps.ui.info(deps.t('repl.loop-start', { every: everySeconds, times }));

  const ctrl = beginTurn();
  try {
    const result = await runIntervalLoop({
      everySeconds,
      times,
      signal: ctrl.signal,
      run: async (iteration) => {
        deps.ui.info(deps.t('repl.loop-iteration', { iteration, times }));
        const seed = sessionSeed(runtime); // each pass carries the (compacted) prior context
        const turnResult = await runAgentTurn(
          agentTurnDeps(deps, runtime, ctrl.signal),
          prompt,
          seed,
        );
        await recordAssistantTurn(deps, runtime, turnResult);
      },
    });
    const summary =
      result.status === 'completed'
        ? deps.t('repl.loop-completed', { iterations: result.iterations })
        : deps.t('repl.loop-cancelled', { iterations: result.iterations });
    deps.ui.info(summary);
    runtime.store.appendTurn(runtime.session.id, { role: 'system', kind: 'status', text: summary });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.ui.error(reason);
    runtime.store.appendTurn(runtime.session.id, {
      role: 'system',
      kind: 'status',
      text: `error: ${reason}`,
    });
  } finally {
    endTurn();
  }
}

/**
 * `!<command>` — real shell passthrough. Runs the command in the repo root,
 * streams its (truncated, redacted) output, and records a status turn. Output
 * is capped to keep the transcript clean; a non-zero exit is reported.
 */
async function runShellPassthrough(
  deps: CliDeps,
  runtime: SessionRuntime,
  command: string,
): Promise<void> {
  if (command.length === 0) {
    deps.ui.warn(deps.t('repl.shell-empty'));
    return;
  }
  deps.ui.write(pc.dim(`$ ${command}`));
  try {
    const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', command], {
      cwd: runtime.repoRoot,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    });
    const output = redactSecrets(`${stdout}${stderr}`).trimEnd();
    const shown = output.length > 4000 ? `${output.slice(0, 4000)}…` : output;
    if (shown.length > 0) {
      deps.ui.write(shown);
    }
    runtime.store.appendTurn(runtime.session.id, {
      role: 'system',
      kind: 'status',
      text: `shell: ${command} → exit 0`,
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number; message?: string };
    const output = redactSecrets(`${e.stdout ?? ''}${e.stderr ?? ''}`).trimEnd();
    if (output.length > 0) {
      deps.ui.write(output.length > 4000 ? `${output.slice(0, 4000)}…` : output);
    }
    deps.ui.warn(deps.t('repl.shell-failed', { code: e.code ?? 1 }));
    runtime.store.appendTurn(runtime.session.id, {
      role: 'system',
      kind: 'status',
      text: `shell: ${command} → exit ${e.code ?? 1}`,
    });
  }
}

/**
 * `/models` — interactive in-shell picker (P1.14): switch the active model
 * provider mid-session. Reuses `Ui.select` (arrow-key on a TTY, numbered
 * fallback otherwise). The chosen provider is written as `default` in
 * providers.yaml, so the NEXT turn (which re-reads the gateway) uses it.
 */
/**
 * `/agent [name|off]` — select a self-contained custom agent for the session
 * (P1.7b). Its persona/model/sampling/guardrails apply to every subsequent turn
 * (the engine already supports the overrides via P1.7). No arg lists the
 * available agents + the active one; `off`/`none`/`clear` returns to default.
 */
function handleAgentCommand(deps: CliDeps, runtime: SessionRuntime, argv: string[]): void {
  const arg = (argv[0] ?? '').trim();
  const opts = {
    repoRoot: runtime.repoRoot,
    homeDir: deps.homeDir(),
    includeGlobal: deps.includeUserGlobal,
  };

  if (arg === 'off' || arg === 'none' || arg === 'clear') {
    if (runtime.activeAgent === null) {
      deps.ui.info('No custom agent is active.');
    } else {
      const prev = runtime.activeAgent.name;
      runtime.activeAgent = null;
      deps.ui.success(`Custom agent "${prev}" cleared — back to the default agent.`);
    }
    return;
  }

  if (arg.length === 0) {
    // List available agents + show the active one.
    const agents = [...loadCustomAgents(opts).values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    deps.ui.write(
      runtime.activeAgent !== null
        ? `Active agent: ${runtime.activeAgent.name} (${runtime.activeAgent.displayName})`
        : 'Active agent: (default)',
    );
    if (agents.length === 0) {
      deps.ui.info('No custom agents. Create one with `excalibur agents init <name>`.');
      return;
    }
    deps.ui.write('');
    deps.ui.table(
      ['NAME', 'ROLE', 'MODEL', 'DESCRIPTION'],
      agents.map((a) => [a.name, a.role ?? '-', a.model ?? a.provider ?? '-', a.description]),
    );
    deps.ui.info('Switch with: /agent <name>   ·   clear with: /agent off');
    return;
  }

  const agent = resolveCustomAgent(arg, opts);
  if (agent === null) {
    deps.ui.warn(`Unknown agent "${arg}". Run /agent to list available agents.`);
    return;
  }
  runtime.activeAgent = agent;
  deps.ui.success(
    `Agent → ${agent.name} (${agent.displayName})${agent.model !== undefined ? ` · ${agent.model}` : ''}`,
  );
}

async function handleModelsCommand(deps: CliDeps, runtime: SessionRuntime): Promise<void> {
  const ctx = loadGatewayContext(runtime.repoRoot);
  if (!ctx.configured || ctx.providersPath === null) {
    deps.ui.info('No model providers configured yet — run `excalibur models setup` to add one.');
    return;
  }
  const section = ctx.providers.providers as Record<string, unknown>;
  const cheapTarget =
    typeof section['cheap'] === 'string' ? (section['cheap'] as string) : undefined;
  const providers = listSwitchableProviders(section, ctx.providerName, cheapTarget);
  if (providers.filter((p) => !p.current).length === 0) {
    deps.ui.info('Only one model provider is configured — add more with `excalibur models setup`.');
    return;
  }
  const choices = providers.map((p) => ({
    label: p.current ? `${p.name} (current)` : p.name,
    hint: providerHint(p),
  }));
  const defaultIndex = Math.max(
    0,
    providers.findIndex((p) => p.current),
  );
  const picked = await deps.ui.select('Select the active model provider', choices, {
    defaultIndex,
    keymap: resolveSelectKeymap(runtime.config.keybindings?.select),
  });
  const chosen = providers[picked];
  if (chosen === undefined || chosen.current) {
    deps.ui.info(`Active model unchanged (${ctx.providerName}).`);
    return;
  }
  // Persist the new default; the next turn re-reads the gateway and uses it.
  section['default'] = chosen.name;
  // Repoint the fast/`cheap` lane (ghost-text, intent, compaction) to the chosen
  // provider's paired sibling if it exists, else drop it so cheap roles fall back
  // to the new default — never leave the fast lane silently on the old provider.
  const fastSibling = `${chosen.name}-fast`;
  if (section[fastSibling] !== null && typeof section[fastSibling] === 'object') {
    section['cheap'] = fastSibling;
  } else if (section['cheap'] !== undefined) {
    delete section['cheap'];
  }
  writeProvidersFile(runtime.repoRoot, ctx.providers);
  // Refresh the session's cached model so the status line, transcript attribution
  // and compaction window track the switch (inference already re-reads per turn).
  runtime.model = chosen.name;
  deps.ui.success(
    `Active model → ${chosen.name}${chosen.model !== undefined ? ` (${chosen.model})` : ''}`,
  );
}

/** Handles a built-in slash command; returns `'exit'` to leave the loop. */
function handleSlashCommand(
  deps: CliDeps,
  runtime: SessionRuntime,
  name: string,
): 'exit' | 'continue' {
  switch (name) {
    case 'help':
      deps.ui.write(pc.bold(deps.t('repl.help-title')));
      deps.ui.write(deps.t('repl.help-help'));
      deps.ui.write(deps.t('repl.help-plan'));
      deps.ui.write(deps.t('repl.help-goal'));
      deps.ui.write(deps.t('repl.help-loop'));
      deps.ui.write(deps.t('repl.help-swarm'));
      deps.ui.write(deps.t('repl.help-bg'));
      deps.ui.write(deps.t('repl.help-threads'));
      deps.ui.write(deps.t('repl.help-discovery'));
      deps.ui.write(deps.t('repl.help-rewind'));
      deps.ui.write(deps.t('repl.help-changes'));
      deps.ui.write(deps.t('repl.help-fork'));
      deps.ui.write(deps.t('repl.help-undo'));
      deps.ui.write(deps.t('repl.help-compact'));
      deps.ui.write(deps.t('repl.help-remember'));
      deps.ui.write(deps.t('repl.help-model'));
      deps.ui.write('  /models    switch the active model provider (interactive picker)');
      deps.ui.write('  /agent     select a custom agent for the session ( /agent <name> | off )');
      deps.ui.write(deps.t('repl.help-clear'));
      deps.ui.write(deps.t('repl.help-exit'));
      deps.ui.write('');
      deps.ui.write(pc.dim(deps.t('repl.help-freeform-1')));
      deps.ui.write(pc.dim(deps.t('repl.help-freeform-2')));
      deps.ui.write(pc.dim(deps.t('repl.help-freeform-3')));
      return 'continue';
    case 'model': {
      const gateway = loadGatewayContext(runtime.repoRoot);
      deps.ui.write(deps.t('repl.model-provider', { provider: gateway.providerName }));
      deps.ui.write(
        gateway.providersPath !== null
          ? deps.t('repl.model-config', { path: gateway.providersPath })
          : pc.dim(deps.t('repl.model-mock')),
      );
      return 'continue';
    }
    case 'clear':
      // Clear the screen but keep the session and its transcript.
      deps.ui.writeRaw('[2J[H');
      printStatusLine(deps, runtime);
      return 'continue';
    case 'exit':
    case 'quit':
      return 'exit';
    default:
      deps.ui.warn(deps.t('repl.unknown-command', { name }));
      return 'continue';
  }
}

/**
 * `/discovery <idea>` runs the explicit, opt-in clarification flow. Kept as a
 * distinct command (not keyword-routed): the agent's prompts suggest it when a
 * request is too vague to act on, but the shell never routes there by guessing.
 */
async function handleDiscoveryCommand(
  deps: CliDeps,
  runtime: SessionRuntime,
  idea: string,
): Promise<void> {
  if (idea.trim().length === 0) {
    deps.ui.warn(deps.t('repl.discovery-usage'));
    return;
  }
  const safeText = redactSecrets(idea);
  runtime.store.appendPromptHistory(`/discovery ${safeText}`);
  runtime.store.appendTurn(runtime.session.id, {
    role: 'user',
    kind: 'message',
    text: `/discovery ${safeText}`,
  });
  await runDiscoveryFlow(deps, { input: idea, inputType: 'idea', yes: false });
  runtime.store.appendTurn(runtime.session.id, {
    role: 'assistant',
    kind: 'message',
    text: 'Discovery session completed.',
    model: runtime.model,
  });
}

/**
 * `/replay [id]` opens the time-machine scrubber over a run (the given id, or
 * the session's most recent run) reusing the SAME line editor — so it reads its
 * single-key controls from the live session stdin and returns to the prompt on
 * `q`/EOF. Mirrors `excalibur replay` exactly (same {@link runScrubber}).
 */
async function handleReplayCommand(
  deps: CliDeps,
  runtime: SessionRuntime,
  id: string | undefined,
  question: (prompt: string) => Promise<string | null>,
): Promise<void> {
  let runId: string;
  try {
    runId = resolveRun(deps, id).id;
  } catch (error) {
    deps.ui.warn(error instanceof Error ? error.message : String(error));
    return;
  }
  try {
    await runScrubber(deps, runId, { question });
  } catch (error) {
    deps.ui.error(error instanceof Error ? error.message : String(error));
  }
}

/**
 * `/log` — the SESSION-level time-machine front-door. Aggregates every run this
 * session spawned (from the transcript's run refs) into a navigable index, then
 * lets the user drop into ANY run's scrubber (the per-run time-machine) by number
 * — without needing to know its id. Reuses {@link buildSessionLog} +
 * {@link runScrubber}. `q`/empty/EOF exits.
 */
async function handleLogCommand(
  deps: CliDeps,
  runtime: SessionRuntime,
  question: (prompt: string) => Promise<string | null>,
): Promise<void> {
  for (;;) {
    const transcript = runtime.store.readTranscript(runtime.session.id);
    const entries = buildSessionLog(deps.cwd(), transcript);
    for (const line of formatSessionLog(entries, deps.t)) {
      deps.ui.write(line);
    }
    if (entries.length === 0) {
      return;
    }
    const answer = await question(accent(deps.t('session-log.prompt')));
    if (answer === null) {
      return; // EOF / Ctrl-D
    }
    const text = answer.trim().toLowerCase();
    if (text === '' || text === 'q' || text === 'quit' || text === 'exit') {
      return;
    }
    const n = Number.parseInt(text, 10);
    const entry = Number.isNaN(n) ? undefined : entries[n - 1];
    if (entry === undefined) {
      deps.ui.warn(deps.t('session-log.invalid', { max: entries.length }));
      continue;
    }
    try {
      await runScrubber(deps, entry.runId, { question }); // drop into that run's time-machine
    } catch (error) {
      deps.ui.error(error instanceof Error ? error.message : String(error));
    }
    // loop back → re-render the index after returning from the scrubber
  }
}

/**
 * `/changes [id]` — the receipt's progressive-disclosure target: the FULL
 * changed-file list with diffstat for a run (the given id, or the latest),
 * printed inline. Mirrors `excalibur changes` (same {@link buildTurnSummary}).
 */
function handleChangesCommand(deps: CliDeps, id: string | undefined): void {
  let runId: string;
  try {
    runId = resolveRun(deps, id).id;
  } catch (error) {
    deps.ui.warn(error instanceof Error ? error.message : String(error));
    return;
  }
  const summary = buildTurnSummary(loadReplay(deps.cwd(), runId));
  deps.ui.heading(deps.t('repl.changes-heading', { runId }));
  if (summary.changedFiles.length === 0) {
    deps.ui.write(deps.t('repl.changes-none'));
    return;
  }
  const { metrics } = summary;
  deps.ui.write(
    metrics.files === 1
      ? deps.t('repl.changes-metrics-one', {
          files: metrics.files,
          insertions: metrics.insertions,
          deletions: metrics.deletions,
        })
      : deps.t('repl.changes-metrics-many', {
          files: metrics.files,
          insertions: metrics.insertions,
          deletions: metrics.deletions,
        }),
  );
  deps.ui.write();
  for (const file of summary.changedFiles) {
    const stat =
      file.insertions === 0 && file.deletions === 0
        ? ''
        : `  +${file.insertions} −${file.deletions}`;
    deps.ui.write(`  ${changeGlyph(file.status)}  ${file.path}${stat}`);
  }
  deps.ui.write();
  deps.ui.write(deps.t('repl.changes-footer'));
}

/**
 * `/fork <instruction>` — fork the latest run from its LAST step, reusing the
 * cached prefix, and run the new instruction live in an isolated worktree (the
 * user's tree is untouched). To fork from an EARLIER step, use `/rewind` →
 * scrub to the step → `f`. Returns the execution result to record, or null.
 */
async function handleForkCommand(
  deps: CliDeps,
  runtime: SessionRuntime,
  argv: string[],
  signal: AbortSignal,
): Promise<AgentTurnResult | null> {
  const instruction = argv.join(' ').trim();
  if (instruction.length === 0) {
    deps.ui.warn(deps.t('repl.fork-usage'));
    return null;
  }
  let runId: string;
  try {
    runId = resolveRun(deps, undefined).id;
  } catch (error) {
    deps.ui.warn(error instanceof Error ? error.message : String(error));
    return null;
  }
  try {
    // Forking continues the run from its LAST step (an unreadable events.jsonl
    // throws here — kept inside the try so it surfaces cleanly, not a crash).
    const atStep = Math.max(0, loadReplay(runtime.repoRoot, runId).steps.length - 1);
    const result = await runForkTurn(agentTurnDeps(deps, runtime, signal), {
      sourceRunId: runId,
      atStep,
      instruction,
    });
    return result.execution;
  } catch (error) {
    deps.ui.error(error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * `/undo` — revert the working tree by undoing the latest run's changes (gated +
 * pre-flight-checked). Mirrors `excalibur undo` (full revert; use the scrubber's
 * `u` to undo to a specific step).
 */
async function handleUndoCommand(deps: CliDeps): Promise<void> {
  let runId: string;
  try {
    runId = resolveRun(deps, undefined).id;
  } catch (error) {
    deps.ui.warn(error instanceof Error ? error.message : String(error));
    return;
  }
  try {
    await runUndo(deps, runId, 0, { yes: false });
  } catch (error) {
    deps.ui.warn(error instanceof Error ? error.message : String(error));
  }
}

/** Parses the owner/org from a git remote URL (https or ssh); '' when unknown. */
function repoOwnerFromRemote(remoteUrl: string | null): string {
  if (remoteUrl === null) return '';
  const match = /[:/]([^/:]+)\/[^/]+?(?:\.git)?$/.exec(remoteUrl);
  return match?.[1] ?? '';
}

/** Builds the welcome-screen context from git identity + repo state. */
function buildWelcomeContext(deps: CliDeps, repoRoot: string, model: string): WelcomeContext {
  const identity = getGitIdentity(repoRoot);
  const gitInfo = getGitInfo(repoRoot);
  const name = (identity.name ?? '').split(/\s+/)[0] || 'there';
  const hasDiff = getLocalDiff(repoRoot).trim().length > 0;
  const tip = hasDiff ? deps.t('repl.welcome-tip-diff') : deps.t('repl.welcome-tip-default');
  return {
    version: CLI_VERSION,
    name,
    model,
    org: repoOwnerFromRemote(gitInfo.remoteUrl),
    user: identity.email ?? '',
    tip,
    whatsNew: deps.t('repl.welcome-whats-new'),
    epigraph: deps.t('welcome.epigraph'),
    width: process.stdout.columns || 80,
    unicode: deps.env['EXCALIBUR_ASCII'] === undefined,
  };
}

/**
 * A Claude-Code-style accent rule shown ABOVE the prompt while a background run
 * is active, with its title "cutting" the line at the right (the same title-cuts-
 * the-frame motif as the welcome). Pure + width-correct (visible length === W).
 */
export function renderRunRule(label: string, width: number): string {
  const W = Math.max(24, Math.min(width > 0 ? width : 80, 100));
  const max = Math.max(8, W - 10);
  const text = label.length > max ? `${label.slice(0, max - 1)}…` : label;
  const dashes = Math.max(2, W - text.length - 5); // dashes + ' ▶ ' + text + ' ─'
  return `${accent('─'.repeat(dashes))} ${accent('▶')} ${pc.bold(text)} ${accent('─')}`;
}

function printStatusLine(deps: CliDeps, runtime: SessionRuntime): void {
  const status = buildStatusLineModel({
    config: runtime.config,
    model: runtime.model,
    costCents: runtime.costCents,
    autonomyLevel: runtime.autonomyLevel,
  });
  const cost = `$${(status.costCents / 100).toFixed(2)}`;
  const counts = fleetCounts(runtime.fleet);
  const bg =
    counts.active > 0 ? ` · ${accent(deps.t('repl.bg-active', { n: counts.active }))}` : '';
  // INT-5 — surface paused (interrupted) work so it is never silently forgotten.
  const paused =
    counts.paused > 0 ? ` · ${pc.yellow(deps.t('repl.paused-count', { n: counts.paused }))}` : '';
  deps.ui.info(
    `${status.autonomy} · ${status.workflow} · ${status.model} · ${cost} · ${safetyLine(deps.t, runtime.config, runtime.approvals.auto)}${contextUsageLabel(runtime)}${bg}${paused}`,
  );
}

/**
 * Ambient context-usage indicator for the status line — `· ctx ▃▄▅ 62%` from the
 * provider's real last prompt-token count vs the model's window. A small accent
 * micro-gauge (rising cells, painted with the Cobalt palette) makes the pressure
 * legible at a glance. Shown only once it starts to matter (≥50%); the gauge +
 * number turn amber past 80% (compaction keeps it down).
 */
function contextUsageLabel(runtime: SessionRuntime): string {
  const used = runtime.lastInputTokens;
  if (used === undefined || used <= 0) {
    return '';
  }
  const window = compactionContextWindow(runtime.repoRoot, runtime.model);
  if (window <= 0) {
    return '';
  }
  const pct = Math.min(99, Math.round((used / window) * 100));
  if (pct < 50) {
    return '';
  }
  const danger = pct >= 80;
  const fillHex = danger ? shellPalette.warn : shellPalette.accent;
  const gauge = gaugeCells(pct / 100, 5)
    .map((cell) => paint(cell.glyph, cell.filled ? fillHex : shellPalette.rail, shellTier))
    .join('');
  const numHex = danger ? shellPalette.warn : shellPalette.muted;
  return ` · ${paint('ctx', shellPalette.muted, shellTier)} ${gauge} ${paint(`${pct}%`, numHex, shellTier)}`;
}

/** Replays a compact transcript summary when resuming a session. */
function replayTranscript(deps: CliDeps, store: SessionStore, session: LocalSession): void {
  const turns = store.readTranscript(session.id).filter((turn) => turn.kind === 'message');
  deps.ui.info(deps.t('repl.resuming', { id: session.id, turns: turns.length }));
  const recent = turns.slice(-6);
  for (const turn of recent) {
    const who = turn.role === 'user' ? accent('you') : pc.green('ai ');
    const snippet = turn.text.replace(/\s+/g, ' ').slice(0, 100);
    deps.ui.write(`  ${who} ${pc.dim(snippet)}`);
  }
  deps.ui.write();
}

/** Closes the session: status → closed, farewell with a timestamp. */
function closeSession(deps: CliDeps, runtime: SessionRuntime): void {
  runtime.store.updateMetadata(runtime.session.id, { status: 'closed' });
  const now = new Date();
  deps.ui.write();
  deps.ui.info(deps.t('repl.closed', { id: runtime.session.id, timestamp: now.toISOString() }));
  deps.ui.write(deps.t('repl.goodbye'));
}
