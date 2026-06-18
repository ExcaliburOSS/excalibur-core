import {
  SessionStore,
  buildSessionSeed,
  buildStatusLineModel,
  buildTurnSummary,
  changeGlyph,
  classifyGoalIntent,
  compactSession,
  compactSessionAsync,
  createExtensionHost,
  createModelSummarizer,
  DEFAULT_COMPACTION_CONFIG,
  withExtensionMcpServers,
  getGitIdentity,
  getGitInfo,
  getLocalDiff,
  loadReplay,
  MemoryStore,
  parseStructuralInput,
  type AsyncSummarizer,
  type LocalSession,
} from '@excalibur/core';
import { analyzeRepository } from '@excalibur/context-engine';
import { agentUsesGateway, resolveAgentAdapter } from '@excalibur/agent-runtime';
import { estimateTokens, redactSecrets, type ChatMessage } from '@excalibur/model-gateway';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AutonomyLevel, ExcaliburConfig } from '@excalibur/shared';
import pc from 'picocolors';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import {
  loadConfigContext,
  loadGatewayContext,
  requireConfiguredModel,
  safetyLine,
} from '../lib/context';
import { runDiscoveryFlow } from '../commands/discovery';
import { runSwarmFlow } from '../lib/swarm';
import { resolveRun, runScrubber } from '../lib/replay-scrubber';
import { buildSessionLog, formatSessionLog } from '../lib/session-log';
import { buildStartupContext } from '../lib/startup-context';
import { setAutoApprove } from '../lib/config-file';
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
import { runGoalLoop } from './goal-loop';
import { runIntervalLoop } from './interval-loop';

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
  const repoRoot = deps.cwd();
  let config = loadConfigContext(repoRoot).config;
  // Extensions can bring MCP servers (EXT-6); merge them into the session config
  // so the native agent loop connects them too (the repo's own mcp.servers wins).
  // Best-effort — a failing extension load never blocks the session.
  try {
    config = withExtensionMcpServers(config, await createExtensionHost(repoRoot));
  } catch {
    /* extensions are additive; never block the shell on a load failure */
  }
  // Repo analysis warms the context engine (ISD scanning) once per session.
  await analyzeRepository(repoRoot, {
    homeDir: deps.homeDir(),
    includeUserGlobal: deps.includeUserGlobal,
  });
  const gateway = loadGatewayContext(repoRoot);
  const store = new SessionStore(repoRoot);

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
    autonomyLevel: (config.autonomy?.default ?? 3) as AutonomyLevel,
    store,
    session,
    costCents: 0,
    // Resolve the saved auto-accept preference; the prompt below sets it the
    // first time (so future sessions never ask).
    approvals: { auto: config.approvals?.auto === true },
  };

  // Welcome banner (two-column frame + cyberpunk sword) + status line.
  deps.ui.write(renderWelcome(buildWelcomeContext(deps, repoRoot, runtime.model)));
  deps.ui.write();

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

  const history = store.loadPromptHistory().slice().reverse(); // readline wants newest-first
  const editor = deps.ui.openLineEditor({
    history,
    ghostCommands: GHOST_COMMANDS,
    suggest: buildSuggester(deps, runtime),
  });

  // First Ctrl-C (or ESC, on the raw editor) during an in-flight turn cancels
  // it; a second Ctrl-C at an empty prompt exits. We track an AbortController
  // per in-flight dispatch, and tell the editor when a turn is active so the raw
  // editor can route ESC / queue typed input.
  let inFlight: AbortController | null = null;
  let sawSigintAtPrompt = false;

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

  try {
    for (;;) {
      const line = await editor.question(pc.cyan('› '));
      if (line === null) {
        break; // EOF / Ctrl-D
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
      const seed = sessionSeed(runtime);

      const safeText = redactSecrets(text);
      store.appendPromptHistory(safeText);
      store.appendTurn(session.id, { role: 'user', kind: 'message', text: safeText });

      if (input.kind === 'shell') {
        await runShellPassthrough(deps, runtime, input.command);
        printStatusLine(deps, runtime);
        continue;
      }

      // A line that EXPLICITLY signals iterate-until-done ("…until the tests
      // pass", "no pares hasta…") OFFERS the autonomous goal loop — the user
      // confirms; we never silently reroute. Confirm BEFORE beginTurn so the
      // prompt read isn't fighting the turn-active editor.
      const goalIntent = deps.ui.isInteractive()
        ? classifyGoalIntent(text)
        : { isGoal: false, signal: '' };
      let asGoal = false;
      if (goalIntent.isGoal) {
        asGoal = await deps.ui.confirm(
          deps.t('repl.goal-offer', {
            signal: goalIntent.signal,
            max: GOAL_MAX_ITERATIONS,
          }),
          { defaultYes: true },
        );
      }

      // Natural-language turn → the model-driven agent loop. Goal-mode (if
      // accepted) iterates to completion; else auto plan-mode at L4; else a
      // direct turn.
      const ctrl = beginTurn();
      try {
        if (asGoal) {
          await executeGoalLoop(deps, runtime, text, seed, ctrl.signal);
        } else if (runtime.autonomyLevel >= 4) {
          await dispatchPlan(deps, runtime, text, ctrl.signal, seed);
        } else {
          await dispatchAgentTurn(deps, runtime, text, ctrl.signal, seed);
        }
      } catch (error) {
        endTurn();
        const reason = error instanceof Error ? error.message : String(error);
        deps.ui.error(reason);
        store.appendTurn(session.id, { role: 'system', kind: 'status', text: `error: ${reason}` });
        printStatusLine(deps, runtime);
        continue;
      }
      endTurn();
      printStatusLine(deps, runtime);
    }
  } finally {
    offSigint();
    offEscape();
    editor.close();
  }

  closeSession(deps, runtime);
  return 0;
}

/** Slash commands the INSTANT ghost completes (no leading `/`). */
const GHOST_COMMANDS = [
  'help',
  'plan',
  'discovery',
  'rewind',
  'replay',
  'changes',
  'log',
  'fork',
  'undo',
  'auto',
  'compact',
  'remember',
  'goal',
  'loop',
  'swarm',
  'model',
  'clear',
  'exit',
  'quit',
];

/**
 * The MODEL-powered ghost suggester (opt-out via `EXCALIBUR_GHOST=off`). Returns
 * undefined when disabled; otherwise an async fn that asks the session's FAST
 * model for a short, redacted completion of the buffer.
 *
 * It routes to the `cheap` (fast/low-cost) provider when one is paired — that
 * provider runs the fast model with reasoning pinned off (its `extraBody`), so
 * the ghost is snappy and cheap even when the main model is a slow reasoner.
 * With no distinct fast model it falls back to the default and self-gates on
 * SPEED: a short `timeoutMs` + small `maxTokens` means a fast model shows a
 * ghost while a slow/reasoning flagship (e.g. kimi-k2.7-code) simply times out →
 * no ghost, bounded cost. The editor also debounces + cancels per keystroke, and
 * a mock/unconfigured provider yields no ghost (instant slash-completion still works).
 */
function buildSuggester(
  deps: CliDeps,
  runtime: SessionRuntime,
): ((buffer: string, signal: AbortSignal) => Promise<string | null>) | undefined {
  if (deps.env['EXCALIBUR_GHOST'] === 'off') {
    return undefined;
  }
  // Resolve the gateway ONCE (don't re-stat/parse providers.yaml per keystroke).
  const gateway = loadGatewayContext(runtime.repoRoot);
  if (!gateway.configured) {
    return undefined; // no real model → no model ghost (instant ghost still works)
  }
  // Route the ghost to the FAST `cheap` model when one is paired (low latency +
  // cost; its config also pins reasoning-off). Fall back to the default when no
  // distinct fast model exists (single-model configs) — there it self-gates on
  // speed: a slow/reasoning default times out → no ghost.
  const ghostProvider = gateway.cheapProviderName ?? gateway.providerName;
  const providerType = (gateway.providers.providers as Record<string, { type?: string }>)[
    ghostProvider
  ]?.type;
  if (providerType === 'mock') {
    return undefined; // the mock is a test double — never a ghost source
  }
  return async (buffer: string, signal: AbortSignal): Promise<string | null> => {
    try {
      const output = await gateway.gateway.chat({
        provider: ghostProvider,
        messages: [
          {
            role: 'system',
            content:
              "You autocomplete a developer's half-typed input to a coding agent. Reply with ONLY " +
              'the text that should CONTINUE their input (the suffix) — no quotes, no preamble, at ' +
              'most ~8 words. If there is no sensible continuation, reply with nothing.',
          },
          { role: 'user', content: redactSecrets(buffer) },
        ],
        maxTokens: 24,
        timeoutMs: 2000, // a live ghost must be fast; slow/reasoning models time out → no ghost
        metadata: { kind: 'ghost' },
        signal,
      });
      const raw = output.content.trim();
      const suffix = (raw.startsWith(buffer) ? raw.slice(buffer.length) : raw).split('\n')[0] ?? '';
      const trimmed = suffix.slice(0, 60);
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null; // a background suggestion must never disrupt the prompt
    }
  };
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
  // After each recorded turn, auto-compact if the session is over budget
  // (best-effort; respects the `compaction.enabled` switch). Awaited so the next
  // turn's seed reflects the compaction.
  await runCompaction(deps, runtime, { manual: false });
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
    const providerType = (gateway.providers.providers as Record<string, { type?: string }>)[provider]
      ?.type;
    if (providerType === 'mock') {
      return undefined; // the mock is a test double — use the offline summarizer
    }
    return createModelSummarizer({
      chat: gateway.gateway,
      provider,
      locale: sessionLocale(runtime),
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
  opts: { manual: boolean },
): Promise<void> {
  const config = runtime.config.compaction ?? DEFAULT_COMPACTION_CONFIG;
  if (!opts.manual && !config.enabled) {
    return; // the automatic path respects the master switch
  }
  try {
    const turns = runtime.store.readTranscript(runtime.session.id);
    const contextWindow = compactionContextWindow(runtime.repoRoot, runtime.model);
    // The on-disk transcript is lossless (it keeps every turn, even ones already
    // folded into a prior summary). Gating the AUTOMATIC path on that raw total
    // would re-compact the same prefix on every turn once it first goes over
    // budget. Gate instead on the EFFECTIVE context we actually send — the
    // latest summary + kept tail + new turns (what buildSessionSeed produces).
    if (!opts.manual) {
      const latest = runtime.store.latestCompaction(runtime.session.id);
      const effectiveTokens = buildSessionSeed(turns, latest).reduce(
        (sum, message) => sum + estimateTokens(message.content),
        0,
      );
      if (effectiveTokens <= contextWindow - config.reserveTokens) {
        return; // effective context is within budget — no compaction churn
      }
    }
    const summarizer = buildCompactionSummarizer(runtime, config);
    let record;
    if (summarizer !== undefined) {
      try {
        record = await compactSessionAsync(turns, {
          config,
          contextWindow,
          model: runtime.model,
          force: opts.manual,
          locale: sessionLocale(runtime),
          summarize: summarizer,
        });
      } catch {
        // The real-model summary failed (network/timeout) — fall back to the
        // deterministic offline summarizer so compaction still happens.
        record = compactSession(turns, { config, contextWindow, model: runtime.model, force: opts.manual });
      }
    } else {
      record = compactSession(turns, { config, contextWindow, model: runtime.model, force: opts.manual });
    }
    if (record === null) {
      if (opts.manual) {
        deps.ui.info(deps.t('repl.compact-nothing'));
      }
      return;
    }
    runtime.store.appendCompaction(runtime.session.id, record);
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

/** Dispatches a direct model-driven turn (the default NL path). */
async function dispatchAgentTurn(
  deps: CliDeps,
  runtime: SessionRuntime,
  text: string,
  signal: AbortSignal,
  seed: ChatMessage[],
): Promise<void> {
  const result = await runAgentTurn(agentTurnDeps(deps, runtime, signal), text, seed);
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
  const plan = await runPlanTurn(agentTurnDeps(deps, runtime, signal), text, seed);
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

/** Hard iteration cap for `/goal` (anti-runaway; overridable later via config). */
const GOAL_MAX_ITERATIONS = 6;

/** Goals where a green test/build/lint run is an authoritative "done" signal. */
const TEST_GOAL_RE =
  /\b(tests?|build|compiles?|compil\w*|lint|type-?check|typecheck|tipos?|pasan?|pasen|verde|green|ci)\b/i;

/** Whether an objective is about tests/build/lint (→ gate done on a real run). */
export function isTestyGoal(objective: string): boolean {
  return TEST_GOAL_RE.test(objective);
}

/**
 * A deterministic "tests green" check for the goal loop, built from the repo's
 * configured test command. Runs it with NO shell (split on whitespace), the
 * loop's abort signal, and a hard timeout; exit 0 → authoritative DONE. Returns
 * undefined when no test command is configured (model judge only).
 */
export function runConfiguredTestsCheck(
  repoRoot: string,
  testCommand: string | undefined,
  signal: AbortSignal | undefined,
): (() => Promise<{ passed: boolean; detail: string }>) | undefined {
  const command = testCommand?.trim();
  if (command === undefined || command.length === 0) {
    return undefined;
  }
  const [bin, ...args] = command.split(/\s+/);
  return async () => {
    try {
      await execFileAsync(bin ?? '', args, {
        cwd: repoRoot,
        ...(signal !== undefined ? { signal } : {}),
        timeout: 300_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { passed: true, detail: `\`${command}\` passed` };
    } catch (error) {
      const first = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
      return { passed: false, detail: `\`${command}\` failed: ${first.slice(0, 140)}` };
    }
  };
}

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
  // For test/build/lint goals, gate "done" on the real test command (a green run
  // is authoritative); the cheap-model judge handles everything else.
  const deterministicCheck = isTestyGoal(objective)
    ? runConfiguredTestsCheck(runtime.repoRoot, runtime.config.commands?.test, signal)
    : undefined;
  if (deterministicCheck !== undefined) {
    deps.ui.info(deps.t('repl.goal-done-gate', { test: runtime.config.commands?.test ?? '' }));
  }
  const result = await runGoalLoop(agentTurnDeps(deps, runtime, signal), objective, {
    maxIterations: GOAL_MAX_ITERATIONS,
    signal,
    seed,
    ...(cheap !== undefined ? { evaluatorProvider: cheap } : {}),
    ...(deterministicCheck !== undefined ? { deterministicCheck } : {}),
    onIteration: (n, verdict) =>
      deps.ui.info(
        deps.t('repl.goal-iteration', {
          n,
          max: GOAL_MAX_ITERATIONS,
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
      deps.ui.write(deps.t('repl.help-discovery'));
      deps.ui.write(deps.t('repl.help-rewind'));
      deps.ui.write(deps.t('repl.help-changes'));
      deps.ui.write(deps.t('repl.help-fork'));
      deps.ui.write(deps.t('repl.help-undo'));
      deps.ui.write(deps.t('repl.help-compact'));
      deps.ui.write(deps.t('repl.help-remember'));
      deps.ui.write(deps.t('repl.help-model'));
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
    const answer = await question(pc.cyan(deps.t('session-log.prompt')));
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
    width: process.stdout.columns || 80,
    unicode: deps.env['EXCALIBUR_ASCII'] === undefined,
  };
}

function printStatusLine(deps: CliDeps, runtime: SessionRuntime): void {
  const status = buildStatusLineModel({
    config: runtime.config,
    model: runtime.model,
    costCents: runtime.costCents,
    autonomyLevel: runtime.autonomyLevel,
  });
  const cost = `$${(status.costCents / 100).toFixed(2)}`;
  deps.ui.info(
    `${status.autonomy} · ${status.workflow} · ${status.model} · ${cost} · ${safetyLine(deps.t, runtime.config)}`,
  );
}

/** Replays a compact transcript summary when resuming a session. */
function replayTranscript(deps: CliDeps, store: SessionStore, session: LocalSession): void {
  const turns = store.readTranscript(session.id).filter((turn) => turn.kind === 'message');
  deps.ui.info(deps.t('repl.resuming', { id: session.id, turns: turns.length }));
  const recent = turns.slice(-6);
  for (const turn of recent) {
    const who = turn.role === 'user' ? pc.cyan('you') : pc.green('ai ');
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
