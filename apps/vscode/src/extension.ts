import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as vscode from 'vscode';
import {
  AcpClient,
  type AcpTransport,
  type PermissionRequest,
  type SessionUpdate,
} from './acp-client';
import { buildPrompt, type EditorContext } from './context-ref';
import { sessionViewHtml, toViewMessage } from './session-view';

/**
 * Excalibur VS Code / Cursor / Windsurf extension (P1.5).
 *
 * Spawns `excalibur acp` as a subprocess and bridges it via the Agent Client
 * Protocol (ndjson JSON-RPC over stdio): the user runs tasks / asks about a
 * selection, the agent streams its work into an output channel, and tool-action
 * approvals surface as native modals. None of these editors host external ACP
 * agents natively, so this extension is the integration path for all three.
 */

const OUTPUT_NAME = 'Excalibur';

/** The single in-flight run (one agent at a time keeps the UX legible). */
interface ActiveRun {
  client: AcpClient;
  child: ChildProcessWithoutNullStreams;
  sessionId: string | null;
  cancelled: boolean;
}

let output: vscode.OutputChannel | undefined;
let active: ActiveRun | null = null;
/** The optional webview session panel (P1.5b); null until the user opens it. */
let sessionPanel: vscode.WebviewPanel | undefined;

/** Random nonce for the webview CSP `script-src 'nonce-…'`. */
function nonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 24; i += 1) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/** Opens (or reveals) the webview session view. */
function openSessionView(): void {
  if (sessionPanel !== undefined) {
    sessionPanel.reveal(vscode.ViewColumn.Beside);
    return;
  }
  sessionPanel = vscode.window.createWebviewPanel(
    'excaliburSession',
    'Excalibur Session',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  sessionPanel.webview.html = sessionViewHtml(nonce());
  sessionPanel.onDidDispose(() => {
    sessionPanel = undefined;
  });
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel(OUTPUT_NAME);
  context.subscriptions.push(output);

  const register = (command: string, handler: () => Promise<void> | void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };

  register('excalibur.run', () => runTaskCommand());
  register('excalibur.askSelection', () => askSelectionCommand());
  register('excalibur.explainFile', () => explainFileCommand());
  register('excalibur.reviewSelection', () => reviewSelectionCommand());
  register('excalibur.cancel', () => cancelCommand());
  register('excalibur.openTerminal', () => openTerminalCommand());
  register('excalibur.openSessionView', () => openSessionView());
}

export function deactivate(): void {
  if (active !== null) {
    killRun(active);
    active = null;
  }
}

/**
 * Tears a run down HARD: dispose the ACP client (EOF on stdin), then SIGTERM the
 * child, escalating to SIGKILL if it doesn't exit. Without this, closing stdin
 * alone leaves a mid-tool-execution CLI orphaned (it keeps editing / spending
 * tokens with no parent). Idempotent + never throws.
 */
function killRun(run: ActiveRun): void {
  try {
    run.client.dispose();
  } catch {
    /* already disposed */
  }
  try {
    run.child.kill('SIGTERM');
  } catch {
    /* already dead */
  }
  const timer = setTimeout(() => {
    try {
      run.child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }, 3000);
  timer.unref?.();
  run.child.once('exit', () => clearTimeout(timer));
}

// ── commands ──────────────────────────────────────────────────────────────────

async function runTaskCommand(): Promise<void> {
  const task = await vscode.window.showInputBox({
    prompt: 'What should Excalibur do?',
    placeHolder: 'e.g. Add a retry guard to the webhook handler',
    ignoreFocusOut: true,
  });
  if (task === undefined || task.trim().length === 0) {
    return;
  }
  await startRun(buildPrompt(task, editorContext({ includeSelection: false })));
}

async function askSelectionCommand(): Promise<void> {
  const ctx = editorContext({ includeSelection: true });
  if (ctx.selection === undefined) {
    void vscode.window.showWarningMessage('Excalibur: select some code first.');
    return;
  }
  const question = await vscode.window.showInputBox({
    prompt: 'Ask Excalibur about the selection',
    placeHolder: 'e.g. What does this do? Is there a bug?',
    ignoreFocusOut: true,
  });
  if (question === undefined || question.trim().length === 0) {
    return;
  }
  await startRun(buildPrompt(question, ctx));
}

async function explainFileCommand(): Promise<void> {
  const ctx = editorContext({ includeSelection: false, includeDocument: true });
  if (ctx.filePath === undefined) {
    void vscode.window.showWarningMessage('Excalibur: open a file first.');
    return;
  }
  await startRun(
    buildPrompt(`Explain ${ctx.filePath}: its purpose, key pieces, and anything risky.`, ctx),
  );
}

async function reviewSelectionCommand(): Promise<void> {
  const ctx = editorContext({ includeSelection: true });
  if (ctx.selection === undefined) {
    void vscode.window.showWarningMessage('Excalibur: select some code to review.');
    return;
  }
  await startRun(
    buildPrompt('Review this code: find bugs, edge cases and risks, with concrete fixes.', ctx),
  );
}

function cancelCommand(): void {
  if (active === null) {
    void vscode.window.showInformationMessage('Excalibur: nothing is running.');
    return;
  }
  const run = active;
  run.cancelled = true;
  out().appendLine('— cancellation requested —');
  if (run.sessionId !== null) {
    // Ask the CLI to stop gracefully, then HARD-kill if it doesn't honor it
    // within the grace window (a session/cancel is a best-effort notification —
    // a hung/uncooperative run must still be stoppable).
    run.client.cancel(run.sessionId);
    const timer = setTimeout(() => {
      if (active === run) {
        out().appendLine('— forcing stop —');
        killRun(run);
      }
    }, 4000);
    timer.unref?.();
  } else {
    // Still initializing (no session yet) — nothing to cancel gracefully; the
    // child is already spawned, so stop it now.
    killRun(run);
  }
}

function openTerminalCommand(): void {
  const cfg = vscode.workspace.getConfiguration('excalibur');
  const command = cfg.get<string>('command', 'excalibur');
  const terminal = vscode.window.createTerminal('Excalibur');
  terminal.show();
  terminal.sendText(command, false);
}

// ── run lifecycle ───────────────────────────────────────────────────────────

async function startRun(prompt: string): Promise<void> {
  if (active !== null) {
    const choice = await vscode.window.showWarningMessage(
      'Excalibur is already running. Cancel it and start a new task?',
      { modal: true },
      'Cancel & Start',
    );
    if (choice !== 'Cancel & Start') {
      return;
    }
    killRun(active);
    active = null;
  }

  const cfg = vscode.workspace.getConfiguration('excalibur');
  const command = cfg.get<string>('command', 'excalibur');
  const args = cfg.get<string[]>('args', ['acp']);
  const cwd =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
    vscode.workspace.rootPath ??
    process.cwd();

  const channel = out();
  channel.show(true);
  channel.appendLine(`\n$ ${command} ${args.join(' ')}  (cwd: ${cwd})`);
  channel.appendLine(`▶ ${firstLine(prompt)}`);

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command, args, { cwd, stdio: 'pipe' });
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Excalibur: could not launch "${command}". Is the CLI installed and on PATH? (${describe(error)})`,
    );
    return;
  }

  // EPIPE safety: a write to a child that has closed its read end emits an async
  // 'error' on the stream; with NO listener Node escalates it to an uncaught
  // exception that can crash the whole extension host. Swallow + log all three.
  const swallow =
    (label: string) =>
    (error: Error): void =>
      channel.appendLine(`· ${label}: ${describe(error)}`);
  child.stdin.on('error', swallow('stdin error'));
  child.stdout.on('error', swallow('stdout error'));
  child.stderr.on('error', swallow('stderr error'));

  const transport = stdioTransport(child, channel);
  const run: ActiveRun = { client: undefined as never, child, sessionId: null, cancelled: false };
  const client = new AcpClient(transport, {
    onUpdate: (_sessionId, update) => {
      renderUpdate(channel, update);
      // Mirror into the webview session view when it is open (P1.5b).
      if (sessionPanel !== undefined) {
        const message = toViewMessage(update);
        if (message !== null) void sessionPanel.webview.postMessage(message);
      }
    },
    onPermission: (request) => askPermission(request, cfg.get<string>('autoApprove', 'ask')),
    onLog: (message) => channel.appendLine(`· ${message}`),
  });
  run.client = client;
  active = run;
  void setRunning(true);

  let spawnFailed = false;
  let exited = false;
  let exitCode: number | null = null;
  child.on('error', (error) => {
    spawnFailed = true;
    void vscode.window.showErrorMessage(
      `Excalibur: failed to start "${command}" — ${describe(error)}. Set "excalibur.command" to the CLI path.`,
    );
  });
  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
  });
  // Drive cleanup off the child lifecycle too: if the process goes away, never
  // leave the `excalibur.running` key stuck on (it gates the Cancel affordances).
  child.on('close', () => {
    if (active === run) {
      active = null;
      void setRunning(false);
    }
  });

  try {
    await client.initialize();
    await client.authenticate();
    const sessionId = await client.newSession(cwd);
    run.sessionId = sessionId;
    const { stopReason } = await client.prompt(sessionId, prompt);
    channel.appendLine(stopReason === 'cancelled' ? '\n■ cancelled' : '\n■ done');
  } catch (error) {
    if (!spawnFailed && !run.cancelled) {
      // Distinguish "the CLI died before/at the handshake" from a protocol error,
      // so a misconfigured command gives actionable guidance instead of an opaque
      // "ACP transport closed".
      const message = exited
        ? `the CLI exited (code ${exitCode ?? '?'}) before responding — check that \`${command} ${args.join(' ')}\` runs and the CLI is installed.`
        : describe(error);
      channel.appendLine(`\n✗ ${message}`);
      void vscode.window.showErrorMessage(`Excalibur: ${message}`);
    }
  } finally {
    killRun(run);
    // Only relinquish the running state if THIS run is still the active one — a
    // newer pre-empting run owns the key otherwise (avoids a stuck/false toggle).
    if (active === run) {
      active = null;
      void setRunning(false);
    }
  }
}

// ── ACP ⇄ editor glue ─────────────────────────────────────────────────────────

/** A newline-delimited stdio transport over the spawned child process. */
function stdioTransport(
  child: ChildProcessWithoutNullStreams,
  channel: vscode.OutputChannel,
): AcpTransport {
  let lineHandler: (line: string) => void = () => {};
  let closeHandler: () => void = () => {};
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      lineHandler(line);
      nl = buffer.indexOf('\n');
    }
  });
  // The CLI keeps stdout for protocol only; stderr carries logs/errors.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    const text = chunk.trimEnd();
    if (text.length > 0) channel.appendLine(`· ${text}`);
  });
  child.on('close', () => closeHandler());

  return {
    send: (message: string): void => {
      if (child.stdin.writable) {
        child.stdin.write(`${message}\n`);
      }
    },
    onLine: (handler): void => {
      lineHandler = handler;
    },
    onClose: (handler): void => {
      closeHandler = handler;
    },
    close: (): void => {
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
    },
  };
}

/** Renders one streamed update into the output channel. */
function renderUpdate(channel: vscode.OutputChannel, update: SessionUpdate): void {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = update.content?.text;
      if (typeof text === 'string' && text.length > 0) {
        channel.append(text);
      }
      break;
    }
    case 'tool_call':
      channel.appendLine(`\n  ⚙ ${update.title ?? update.toolCallId ?? 'tool'} …`);
      break;
    case 'tool_call_update':
      channel.appendLine(
        `  ${update.status === 'failed' ? '✗' : '✓'} ${update.toolCallId ?? 'tool'}`,
      );
      break;
    case 'plan': {
      const entries = update.entries ?? [];
      if (entries.length > 0) {
        channel.appendLine('\n  Plan:');
        for (const e of entries) {
          const mark = e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '▸' : '○';
          channel.appendLine(`    ${mark} ${e.content}`);
        }
      }
      break;
    }
    default:
      break;
  }
}

/** Maps an ACP permission request to a native modal; returns the chosen optionId. */
async function askPermission(request: PermissionRequest, policy: string): Promise<string | null> {
  const allow = request.options.find((o) => o.optionId === 'allow') ?? request.options[0];
  if (policy === 'allow' && allow !== undefined) {
    return allow.optionId;
  }
  const labels = request.options.map((o) => o.name);
  const choice = await vscode.window.showInformationMessage(
    'Excalibur wants to run a tool action. Allow it?',
    { modal: true },
    ...labels,
  );
  if (choice === undefined) {
    return null; // dismissed → decline
  }
  const picked = request.options.find((o) => o.name === choice);
  return picked?.optionId ?? null;
}

// ── editor context capture ────────────────────────────────────────────────────

function editorContext(opts: {
  includeSelection: boolean;
  includeDocument?: boolean;
}): EditorContext {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    return {};
  }
  const ctx: EditorContext = {
    filePath: vscode.workspace.asRelativePath(editor.document.uri, false),
    languageId: editor.document.languageId,
  };
  if (opts.includeSelection && !editor.selection.isEmpty) {
    ctx.selection = {
      startLine: editor.selection.start.line + 1, // VS Code is 0-based; surface 1-based
      endLine: editor.selection.end.line + 1,
      text: editor.document.getText(editor.selection),
    };
  }
  if (opts.includeDocument === true) {
    ctx.documentText = editor.document.getText();
  }
  return ctx;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function out(): vscode.OutputChannel {
  if (output === undefined) {
    output = vscode.window.createOutputChannel(OUTPUT_NAME);
  }
  return output;
}

function setRunning(running: boolean): Thenable<unknown> {
  return vscode.commands.executeCommand('setContext', 'excalibur.running', running);
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
