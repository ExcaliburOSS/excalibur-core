import {
  SessionStore,
  buildStatusLineModel,
  getGitIdentity,
  getGitInfo,
  getLocalDiff,
  parseStructuralInput,
  type LocalSession,
} from '@excalibur/core';
import { analyzeRepository } from '@excalibur/context-engine';
import { redactSecrets } from '@excalibur/model-gateway';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AutonomyLevel, ExcaliburConfig } from '@excalibur/shared';
import pc from 'picocolors';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { loadConfigContext, loadGatewayContext, safetyLine } from '../lib/context';
import { runDiscoveryFlow } from '../commands/discovery';
import { CLI_VERSION } from '../program';
import { renderWelcome, type WelcomeContext } from './welcome';
import {
  runAgentTurn,
  runPlanTurn,
  type AgentTurnDeps,
  type AgentTurnResult,
} from './agent-turn';

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
  const { config } = loadConfigContext(repoRoot);
  // Repo analysis warms the context engine (ISD scanning) once per session.
  await analyzeRepository(repoRoot, {
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
    model: gateway.providerName,
    autonomyLevel: (config.autonomy?.default ?? 3) as AutonomyLevel,
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

      const input = parseStructuralInput(text);

      // Built-in slash commands are handled inline (never recorded as turns),
      // EXCEPT /plan and /discovery which run (recorded) work.
      if (input.kind === 'command') {
        if (input.name === 'plan') {
          await handlePlanCommand(deps, runtime, input.argv.join(' '), () => {
            inFlight = new AbortController();
            return inFlight;
          });
          inFlight = null;
          printStatusLine(deps, runtime);
          continue;
        }
        if (input.name === 'discovery') {
          await handleDiscoveryCommand(deps, runtime, input.argv.join(' '));
          printStatusLine(deps, runtime);
          continue;
        }
        const result = handleSlashCommand(deps, runtime, input.name);
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

      if (input.kind === 'shell') {
        await runShellPassthrough(deps, runtime, input.command);
        printStatusLine(deps, runtime);
        continue;
      }

      // Natural-language turn → the model-driven agent loop. Auto plan-mode for
      // the highest autonomy level (L4 full-agentic naturally plans first);
      // otherwise a direct turn.
      inFlight = new AbortController();
      try {
        if (runtime.autonomyLevel >= 4) {
          await dispatchPlan(deps, runtime, text, inFlight.signal);
        } else {
          await dispatchAgentTurn(deps, runtime, text, inFlight.signal);
        }
      } catch (error) {
        inFlight = null;
        const reason = error instanceof Error ? error.message : String(error);
        deps.ui.error(reason);
        store.appendTurn(session.id, { role: 'system', kind: 'status', text: `error: ${reason}` });
        printStatusLine(deps, runtime);
        continue;
      }
      inFlight = null;
      printStatusLine(deps, runtime);
    }
  } finally {
    offSigint();
    editor.close();
  }

  closeSession(deps, runtime);
  return 0;
}

/** Builds the agent-turn deps from the session runtime. */
function agentTurnDeps(
  deps: CliDeps,
  runtime: SessionRuntime,
  signal: AbortSignal,
): AgentTurnDeps {
  const gateway = loadGatewayContext(runtime.repoRoot);
  return {
    deps,
    repoRoot: runtime.repoRoot,
    config: runtime.config,
    gateway: gateway.gateway,
    providerName: gateway.providerName,
    autonomyLevel: runtime.autonomyLevel,
    signal,
  };
}

/** Records an assistant turn + accumulates cost from an agent-turn result. */
function recordAssistantTurn(runtime: SessionRuntime, result: AgentTurnResult): void {
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
}

/** Dispatches a direct model-driven turn (the default NL path). */
async function dispatchAgentTurn(
  deps: CliDeps,
  runtime: SessionRuntime,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const result = await runAgentTurn(agentTurnDeps(deps, runtime, signal), text);
  recordAssistantTurn(runtime, result);
}

/** Dispatches an auto plan-mode turn (plan → gate → execute). */
async function dispatchPlan(
  deps: CliDeps,
  runtime: SessionRuntime,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const plan = await runPlanTurn(agentTurnDeps(deps, runtime, signal), text);
  runtime.store.appendTurn(runtime.session.id, {
    role: 'assistant',
    kind: 'message',
    text: plan.planText,
    model: runtime.model,
    artifactRef: plan.planRunId,
  });
  if (plan.execution !== null) {
    recordAssistantTurn(runtime, plan.execution);
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
    deps.ui.warn('Usage: /plan <task>. Describe what you want planned.');
    return;
  }
  const safeText = redactSecrets(task);
  runtime.store.appendPromptHistory(`/plan ${safeText}`);
  runtime.store.appendTurn(runtime.session.id, { role: 'user', kind: 'message', text: `/plan ${safeText}` });
  const controller = newController();
  try {
    await dispatchPlan(deps, runtime, task, controller.signal);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.ui.error(reason);
    runtime.store.appendTurn(runtime.session.id, { role: 'system', kind: 'status', text: `error: ${reason}` });
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
    deps.ui.warn('Empty shell command.');
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
    deps.ui.warn(`Command failed (exit ${e.code ?? 1}).`);
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
      deps.ui.write(pc.bold('Excalibur interactive session — commands'));
      deps.ui.write('  /help          show this help');
      deps.ui.write('  /plan <task>   plan first (read-only) → approve → execute');
      deps.ui.write('  /discovery <idea>  clarify an ambiguous idea before building');
      deps.ui.write('  /model         show the active provider/model');
      deps.ui.write('  /clear         clear the screen (keeps the session)');
      deps.ui.write('  /exit, /quit   close the session and leave');
      deps.ui.write('');
      deps.ui.write(pc.dim('Type anything else in plain words (any language) — the model decides'));
      deps.ui.write(pc.dim('whether to answer (read-only) or edit/run, governed by your autonomy'));
      deps.ui.write(pc.dim('level. Tool actions ask for inline approval. `!cmd` runs a shell command.'));
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
      deps.ui.writeRaw('[2J[H');
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
    deps.ui.warn('Usage: /discovery <idea>. Describe the idea to clarify before building.');
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

/** Reprints the StatusLine: autonomy · workflow · model · cost · safety. */
const WHATS_NEW = 'Model-first agent loop in the shell, inline approvals, plan-mode.';

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
    : 'Describe what you want in plain words — the model decides how to act (ask, edit, run).';
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
    autonomyLevel: runtime.autonomyLevel,
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
