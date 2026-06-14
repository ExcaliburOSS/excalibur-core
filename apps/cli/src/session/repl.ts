import {
  DiscoveryManager,
  InteractionStore,
  SessionStore,
  buildStatusLineModel,
  getGitIdentity,
  getGitInfo,
  getLocalDiff,
  routeInput,
  type LocalSession,
  type RouteContext,
  type RouteDecision,
} from '@excalibur/core';
import { analyzeRepository } from '@excalibur/context-engine';
import { redactSecrets } from '@excalibur/model-gateway';
import type { ExcaliburConfig } from '@excalibur/shared';
import pc from 'picocolors';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { loadConfigContext, loadGatewayContext, safetyLine } from '../lib/context';
import { runInteractionCommand } from '../lib/interactions';
import { runTask } from '../lib/run-pipeline';
import { runDiscoveryFlow } from '../commands/discovery';
import { CLI_VERSION } from '../program';
import { renderWelcome, type WelcomeContext } from './welcome';

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
  routeContext: RouteContext;
  model: string;
  store: SessionStore;
  session: LocalSession;
  /** Running cost sum, in cents, across the session's assistant turns. */
  costCents: number;
}

/** Outcome of dispatching one natural-language turn. */
interface DispatchResult {
  text: string;
  model: string | null;
  costCents: number | null;
  artifactRef: string | null;
}

/**
 * The interactive conversational session (`excalibur` with no args → a
 * readline REPL). M-Shell Slice A: a minimal but production-quality loop that
 * routes each line (deterministically, via `routeInput`) and dispatches it to
 * the existing entrypoints (`ask`/`run`/`discovery`) through the SAME
 * `CliDeps`, so streaming, prompts and approvals all just work. Everything is
 * recorded to a `SessionStore` transcript. Mock is the zero-config default;
 * the whole loop works offline.
 *
 * Returns the process exit code (0 on a graceful close).
 */
export async function runInteractiveSession(
  deps: CliDeps,
  options: InteractiveSessionOptions = {},
): Promise<number> {
  const repoRoot = deps.cwd();
  const { config } = loadConfigContext(repoRoot);
  const analysis = await analyzeRepository(repoRoot, {
    homeDir: deps.homeDir(),
    includeUserGlobal: deps.includeUserGlobal,
  });
  const gateway = loadGatewayContext(repoRoot);
  const store = new SessionStore(repoRoot);

  // Resume / continue / create the session. A resumed session must belong to
  // THIS repo: a session dir copied in from elsewhere would misalign every
  // relative path and artifact reference, so we refuse it rather than silently
  // operate on the wrong tree.
  let session: LocalSession;
  if (options.resume !== undefined) {
    session = store.getSession(options.resume);
    if (session.metadata.repoRoot !== repoRoot) {
      throw new CliUsageError(
        `Session ${session.id} belongs to ${session.metadata.repoRoot}, not this repository. ` +
          'Start a new session here, or resume it from its own repo.',
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
    routeContext: { analysis, config },
    model: gateway.providerName,
    store,
    session,
    costCents: 0,
  };

  // Welcome banner (two-column frame + cyberpunk sword) + status line.
  deps.ui.write(renderWelcome(buildWelcomeContext(deps, repoRoot, runtime.model)));
  deps.ui.write();
  printStatusLine(deps, runtime);

  const history = store.loadPromptHistory().slice().reverse(); // readline wants newest-first
  const editor = deps.ui.openLineEditor({ history });

  // First Ctrl-C during an in-flight turn cancels it; a second at an empty
  // prompt exits. We track an AbortController per in-flight dispatch.
  let inFlight: AbortController | null = null;
  let sawSigintAtPrompt = false;
  const offSigint = editor.onSigint(() => {
    if (inFlight !== null) {
      inFlight.abort();
      inFlight = null;
      deps.ui.write();
      deps.ui.info('Cancelled. Back to the prompt.');
    } else if (sawSigintAtPrompt) {
      editor.close();
    } else {
      sawSigintAtPrompt = true;
      deps.ui.write();
      deps.ui.info('Press Ctrl-C again to exit.');
    }
  });

  try {
    for (;;) {
      const line = await editor.question(pc.cyan('› '));
      if (line === null) {
        break; // EOF / Ctrl-D
      }
      const text = line.trim();
      sawSigintAtPrompt = false;

      if (text.length === 0) {
        printStatusLine(deps, runtime);
        continue;
      }

      const decision = routeInput(text, runtime.routeContext);

      // Built-in slash commands are handled inline (never recorded as turns).
      if (decision.kind === 'command') {
        const result = handleSlashCommand(deps, runtime, decision.name, decision.argv);
        if (result === 'exit') {
          break;
        }
        continue;
      }

      // Record the user turn + remember the prompt for history. The raw `text`
      // still drives dispatch (the user typed it on purpose), but everything
      // PERSISTED to disk is redacted so a pasted key never lands in
      // transcript.jsonl or the history file.
      const safeText = redactSecrets(text);
      store.appendPromptHistory(safeText);
      store.appendTurn(session.id, { role: 'user', kind: 'message', text: safeText });

      if (decision.kind === 'shell') {
        deps.ui.warn(
          'Shell passthrough (`!<command>`) is recognised, but execution lands in a later slice. ' +
            'No command was run.',
        );
        store.appendTurn(session.id, {
          role: 'system',
          kind: 'status',
          text: 'shell passthrough deferred',
        });
        printStatusLine(deps, runtime);
        continue;
      }

      // Natural-language turn: render the routing decision, then dispatch.
      renderDecision(deps, decision);
      store.appendTurn(session.id, {
        role: 'system',
        kind: 'route',
        text: decision.reason,
        route: `${decision.lane}:${decision.intent}`,
      });

      inFlight = new AbortController();
      let dispatch: DispatchResult;
      try {
        dispatch = await dispatchLane(deps, runtime, decision, text);
      } catch (error) {
        inFlight = null;
        const reason = error instanceof Error ? error.message : String(error);
        deps.ui.error(reason);
        store.appendTurn(session.id, { role: 'system', kind: 'status', text: `error: ${reason}` });
        printStatusLine(deps, runtime);
        continue;
      }
      inFlight = null;

      if (dispatch.costCents !== null) {
        runtime.costCents += dispatch.costCents;
      }
      store.appendTurn(session.id, {
        role: 'assistant',
        kind: 'message',
        text: dispatch.text,
        ...(dispatch.model !== null ? { model: dispatch.model } : {}),
        ...(dispatch.costCents !== null ? { costCents: dispatch.costCents } : {}),
        ...(dispatch.artifactRef !== null ? { artifactRef: dispatch.artifactRef } : {}),
      });
      printStatusLine(deps, runtime);
    }
  } finally {
    offSigint();
    editor.close();
  }

  closeSession(deps, runtime);
  return 0;
}

/** Dispatches a natural-language lane to its existing entrypoint. */
async function dispatchLane(
  deps: CliDeps,
  runtime: SessionRuntime,
  decision: Extract<RouteDecision, { kind: 'natural' }>,
  text: string,
): Promise<DispatchResult> {
  switch (decision.lane) {
    case 'ask': {
      const before = latestInteractionId(runtime.repoRoot);
      await runInteractionCommand(deps, { command: 'ask', kind: 'ask', input: text, prompt: text });
      return interactionResult(runtime.repoRoot, before, runtime.model);
    }
    case 'discovery': {
      const before = latestDiscoveryId(runtime.repoRoot);
      await runDiscoveryFlow(deps, { input: text, inputType: 'idea', yes: false });
      const after = latestDiscoveryId(runtime.repoRoot);
      return {
        text: 'Discovery session completed.',
        model: runtime.model,
        costCents: null,
        artifactRef: after !== before ? after : null,
      };
    }
    case 'run':
    case 'careful': {
      const record = await runTask(deps, text, {
        ...(decision.lane === 'careful' ? { style: 'careful' as const } : {}),
      });
      if (record === null) {
        return { text: 'No run was created.', model: runtime.model, costCents: null, artifactRef: null };
      }
      return {
        text: `Run ${record.id} finished with status: ${record.status}.`,
        model: record.model ?? runtime.model,
        costCents: null,
        artifactRef: record.id,
      };
    }
  }
}

/** Loads the model/cost/ref of the interaction created during an ask dispatch. */
function interactionResult(
  repoRoot: string,
  beforeId: string | null,
  providerName: string,
): DispatchResult {
  const store = new InteractionStore(repoRoot);
  const list = store.list();
  const latest = list.length > 0 ? (list[list.length - 1] as (typeof list)[number]) : null;
  if (latest === null || latest.id === beforeId) {
    return { text: 'Answered.', model: providerName, costCents: null, artifactRef: null };
  }
  return {
    text: 'Answered.',
    // The session turn records the PROVIDER name (e.g. `mock`) — the same
    // identity the StatusLine shows — preferring it over the artifact's raw
    // model id (which the gateway may report as `unknown` while streaming).
    model: latest.metadata.provider ?? providerName,
    costCents: latest.metadata.costCents,
    artifactRef: latest.id,
  };
}

function latestInteractionId(repoRoot: string): string | null {
  const list = new InteractionStore(repoRoot).list();
  return list.length > 0 ? (list[list.length - 1]?.id ?? null) : null;
}

function latestDiscoveryId(repoRoot: string): string | null {
  const list = new DiscoveryManager(repoRoot).listSessions();
  return list.length > 0 ? (list[list.length - 1]?.id ?? null) : null;
}

/** Handles a built-in slash command; returns `'exit'` to leave the loop. */
function handleSlashCommand(
  deps: CliDeps,
  runtime: SessionRuntime,
  name: string,
  _argv: string[],
): 'exit' | 'continue' {
  switch (name) {
    case 'help':
      deps.ui.write(pc.bold('Excalibur interactive session — commands & lanes'));
      deps.ui.write('  /help          show this help');
      deps.ui.write('  /model         show the active provider/model');
      deps.ui.write('  /clear         clear the screen (keeps the session)');
      deps.ui.write('  /exit, /quit   close the session and leave');
      deps.ui.write('');
      deps.ui.write(pc.dim('Lanes (chosen automatically from what you type):'));
      deps.ui.write(pc.dim('  ask        a question about the repo (read-only)'));
      deps.ui.write(pc.dim('  run        an actionable task (isolated branch, approvals)'));
      deps.ui.write(pc.dim('  careful    a sensitive task (Level 4, stronger approvals)'));
      deps.ui.write(pc.dim('  discovery  an ambiguous idea (clarify before building)'));
      deps.ui.write(pc.dim('  !<command> shell passthrough (lands in a later slice)'));
      return 'continue';
    case 'model': {
      const gateway = loadGatewayContext(runtime.repoRoot);
      deps.ui.write(`Provider: ${gateway.providerName}`);
      deps.ui.write(
        gateway.providersPath !== null
          ? `Config: ${gateway.providersPath}`
          : pc.dim('Using the built-in mock provider (no providers.yaml — the zero-config default).'),
      );
      return 'continue';
    }
    case 'clear':
      // Clear the screen but keep the session and its transcript.
      deps.ui.writeRaw('[2J[H');
      printStatusLine(deps, runtime);
      return 'continue';
    case 'exit':
    case 'quit':
      return 'exit';
    default:
      deps.ui.warn(`Unknown command: /${name}. Try /help.`);
      return 'continue';
  }
}

/** Renders the routing decision as a dim line: lane · workflow · autonomy. */
function renderDecision(deps: CliDeps, decision: Extract<RouteDecision, { kind: 'natural' }>): void {
  const workflow =
    decision.lane === 'ask'
      ? 'ask-repo'
      : decision.lane === 'discovery'
        ? 'discovery'
        : decision.lane === 'careful'
          ? 'careful'
          : 'run';
  const autonomy =
    decision.lane === 'ask'
      ? 'L1'
      : decision.lane === 'discovery'
        ? 'L0'
        : decision.lane === 'careful'
          ? 'L4'
          : 'L3';
  deps.ui.info(`→ ${decision.lane} · ${workflow} · ${autonomy}`);
}

/** Reprints the StatusLine: autonomy · workflow · model · cost · safety. */
const WHATS_NEW = 'Real model gateway, repo-aware context, and live streaming.';

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
  const tip = hasDiff
    ? 'You have uncommitted changes — try “review the working diff”.'
    : 'Describe what you want in plain words — Excalibur routes it to ask, run, patch or discovery.';
  return {
    version: CLI_VERSION,
    name,
    model,
    org: repoOwnerFromRemote(gitInfo.remoteUrl),
    user: identity.email ?? '',
    tip,
    whatsNew: WHATS_NEW,
    width: process.stdout.columns || 80,
    unicode: deps.env['EXCALIBUR_ASCII'] === undefined,
  };
}

function printStatusLine(deps: CliDeps, runtime: SessionRuntime): void {
  const status = buildStatusLineModel({
    config: runtime.config,
    model: runtime.model,
    costCents: runtime.costCents,
  });
  const cost = `$${(status.costCents / 100).toFixed(2)}`;
  deps.ui.info(
    `${status.autonomy} · ${status.workflow} · ${status.model} · ${cost} · ${safetyLine(runtime.config)}`,
  );
}

/** Replays a compact transcript summary when resuming a session. */
function replayTranscript(deps: CliDeps, store: SessionStore, session: LocalSession): void {
  const turns = store.readTranscript(session.id).filter((turn) => turn.kind === 'message');
  deps.ui.info(`Resuming session ${session.id} (${turns.length} message turns).`);
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
  deps.ui.info(`Session ${runtime.session.id} closed (just now · ${now.toISOString()}).`);
  deps.ui.write('Goodbye.');
}
