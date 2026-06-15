import type { ExcaliburEvent } from '@excalibur/shared';
import pc from 'picocolors';
import type { CliDeps } from '../deps';

/**
 * The live per-action renderer for the conversational agent loop (M-Shell).
 *
 * Claude Code's strength is that you SEE each step: a tool header (verb +
 * target) with its result indented beneath, edits as diffs, command output and
 * exit code, all clearly grouped. The old flat one-line-per-event renderer
 * (`describeEvent`, still used by the batch `excalibur run` log) could not do
 * this. This stateful renderer consumes the native loop's event stream and
 * groups it into blocks:
 *
 *     ▸ Analyze
 *       ⏺ Read   src/billing/charge.ts              42 lines
 *       ⏺ Bash   npm test
 *         ⎿ 142 passed                              exit 0 · 1.2s
 *       ⏺ Patch  apply
 *         ⎿ + if (!cart) return 0;
 *           + return cart.total;
 *
 * It pairs each `tool_call` announcement with the result event that follows
 * (they are strictly sequential in the loop), measures wall-time between the
 * two, renders real diffs with a +/− gutter, previews/truncates long output,
 * and shows the model's intermediate narration (the prose BEFORE a tool call)
 * without ever duplicating the FINAL answer — that belongs to the post-turn
 * receipt. A live animated spinner is intentionally NOT built here: it needs a
 * transient-line capability that lands with the `@excalibur/tui` Ink surface;
 * the header→result two-step degrades perfectly to a CI/non-TTY log.
 *
 * No `Date.now` ban applies (this is a CLI surface, not core); timing uses the
 * real clock and is injectable for tests via `opts.clock`.
 */

/** How many diff/body lines to show before truncating with a "… +N" note. */
const BODY_CAP = 10;
/** Pad the tool verb to this width so targets align. */
const VERB_WIDTH = 6;

export interface ActionRendererOptions {
  /** Nerd-font glyphs vs ASCII fallback. */
  unicode?: boolean;
  /** Injectable clock (ms) for deterministic elapsed-time tests. */
  clock?: () => number;
}

interface PendingCall {
  verb: string;
  args: Record<string, unknown>;
  startedAtMs: number;
}

/** Reads a string payload field, or ''. */
function s(event: ExcaliburEvent, key: string): string {
  const value = event.payload[key];
  return typeof value === 'string' ? value : '';
}

/** Tool name → display verb. */
function verbFor(tool: string): string {
  switch (tool) {
    case 'read_file':
      return 'Read';
    case 'write_file':
      return 'Write';
    case 'list_files':
      return 'List';
    case 'search_code':
      return 'Search';
    case 'run_command':
      return 'Bash';
    case 'run_tests':
      return 'Test';
    case 'git_diff':
      return 'Diff';
    case 'apply_patch':
      return 'Patch';
    case 'create_branch':
      return 'Branch';
    default:
      return tool;
  }
}

/** The header target for a tool from its (redacted) arguments. */
function targetFor(tool: string, args: Record<string, unknown>): string {
  const a = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
  switch (tool) {
    case 'read_file':
    case 'write_file':
    case 'list_files':
      return a('path');
    case 'search_code':
      return a('query') || a('pattern');
    case 'run_command':
      return a('command');
    case 'run_tests':
      return a('command') || '(detected test)';
    case 'create_branch':
      return a('name');
    case 'apply_patch':
      return 'apply';
    case 'git_diff':
      return '';
    default:
      return '';
  }
}

export class ActionRenderer {
  private readonly ui: CliDeps['ui'];
  private readonly unicode: boolean;
  private readonly clock: () => number;
  private pending: PendingCall | null = null;
  private narration: string | null = null;

  constructor(deps: CliDeps, options: ActionRendererOptions = {}) {
    this.ui = deps.ui;
    this.unicode = options.unicode ?? true;
    this.clock = options.clock ?? ((): number => Date.now());
  }

  private g(unicode: string, ascii: string): string {
    return this.unicode ? unicode : ascii;
  }

  /** Feed one streamed event. Renders incrementally; safe on any event order. */
  onEvent(event: ExcaliburEvent): void {
    switch (event.type) {
      case 'phase_started':
        this.dropNarration();
        this.ui.write(pc.cyan(`${this.g('▸', '>')} ${s(event, 'name') || 'phase'}`));
        return;
      case 'model_call': {
        const content = s(event, 'content').trim();
        this.narration = content.length > 0 ? content : null;
        return;
      }
      case 'assistant_message':
        // The FINAL answer is the receipt's job — never echo it here.
        this.dropNarration();
        return;
      case 'tool_call':
        if (this.isResult(event)) {
          this.renderResult(event); // a git_diff result rides as a tool_call event
        } else {
          this.startCall(event);
        }
        return;
      case 'file_read':
      case 'file_write':
      case 'command_completed':
      case 'patch_applied':
      case 'branch_created':
        this.renderResult(event);
        return;
      case 'patch_generated':
        this.dropNarration();
        this.renderAggregateDiff(event);
        return;
      case 'policy_decision':
        if (event.payload['kind'] === 'confirmation' && event.payload['decision'] === 'deny') {
          const msg = s(event, 'message') || 'declined';
          this.closeWithResult(`    ${pc.yellow(this.g('⎿', 'L'))} ${pc.yellow(msg)}`);
        }
        return;
      case 'error':
        this.closeWithResult(`    ${pc.red(this.g('⎿', 'L'))} ${pc.red(`error: ${s(event, 'message')}`)}`);
        return;
      default:
        return; // run_started/completed, phase_completed, *_selected → not actions
    }
  }

  /** Stops any open block (no-op today; reserved for a future spinner). */
  finish(): void {
    this.pending = null;
  }

  // --- internals -------------------------------------------------------------

  /** A `tool_call` event is a RESULT (git_diff) when it carries `result`, not args. */
  private isResult(event: ExcaliburEvent): boolean {
    return !('arguments' in event.payload) && ('result' in event.payload || 'ok' in event.payload);
  }

  private startCall(event: ExcaliburEvent): void {
    this.flushNarration();
    const tool = s(event, 'tool') || s(event, 'name');
    const args =
      (event.payload['arguments'] as Record<string, unknown> | undefined) ?? {};
    const verb = verbFor(tool);
    const target = targetFor(tool, args);
    this.pending = { verb, args, startedAtMs: this.clock() };
    const head = `  ${pc.cyan(this.g('⏺', '*'))} ${verb.padEnd(VERB_WIDTH)} ${pc.dim(target)}`.trimEnd();
    this.ui.write(head);
  }

  /** Renders the result body of the pending (or just-seen) tool call. */
  private renderResult(event: ExcaliburEvent): void {
    const tool = s(event, 'tool') || s(event, 'name');
    const ok = event.payload['ok'] !== false;
    const elapsed = this.pending !== null ? this.clock() - this.pending.startedAtMs : null;
    const args = this.pending?.args ?? {};

    if (!ok) {
      this.closeWithResult(pc.red(`${this.indent()} ${s(event, 'result') || 'failed'}`));
      return;
    }

    const body = this.bodyFor(tool, event, args, elapsed);
    for (const line of body) {
      this.ui.write(line);
    }
    this.pending = null;
  }

  /** The indented result connector (`⎿`). */
  private indent(): string {
    return `    ${pc.dim(this.g('⎿', 'L'))}`;
  }

  /** Builds the result lines for a completed tool. */
  private bodyFor(
    tool: string,
    event: ExcaliburEvent,
    args: Record<string, unknown>,
    elapsedMs: number | null,
  ): string[] {
    const elapsed = formatElapsed(elapsedMs);
    switch (tool) {
      case 'read_file': {
        const lines = countLines(s(event, 'result'));
        return [`${this.indent()} ${pc.dim(`${lines} line${lines === 1 ? '' : 's'}`)}`];
      }
      case 'list_files': {
        const n = countLines(s(event, 'result'));
        return [`${this.indent()} ${pc.dim(`${n} entr${n === 1 ? 'y' : 'ies'}`)}`];
      }
      case 'search_code': {
        const n = countLines(s(event, 'result'));
        return [`${this.indent()} ${pc.dim(`${n} match line${n === 1 ? '' : 'es'}`)}`];
      }
      case 'write_file': {
        const note = s(event, 'result') || 'written';
        return [`${this.indent()} ${pc.dim(note)}`];
      }
      case 'create_branch':
        return [`${this.indent()} ${pc.dim(`branch ${s(event, 'branch')}`)}`];
      case 'run_command':
      case 'run_tests': {
        const exit = typeof event.payload['exitCode'] === 'number' ? (event.payload['exitCode'] as number) : null;
        const meta = [exit !== null ? `exit ${exit}` : null, elapsed].filter(Boolean).join(' · ');
        // The TAIL of the output is the useful part (test summary / error), not
        // the boilerplate banner at the top.
        const tail = tailLines(s(event, 'result'), 2);
        if (tail.length === 0) {
          return [`${this.indent()} ${pc.dim(meta || 'done')}`];
        }
        const first = `${this.indent()} ${tail[0]}${meta ? `   ${pc.dim(meta)}` : ''}`;
        const rest = tail.slice(1).map((l) => `      ${pc.dim(l)}`);
        return [first, ...rest];
      }
      case 'git_diff':
        return this.diffLines(s(event, 'result'));
      case 'apply_patch': {
        const diff = typeof args['diff'] === 'string' ? (args['diff'] as string) : '';
        const head = this.diffLines(diff);
        return head.length > 0 ? head : [`${this.indent()} ${pc.dim('applied')}`];
      }
      default:
        return [`${this.indent()} ${pc.dim(s(event, 'result') || 'done')}`];
    }
  }

  /** Renders the aggregate end-of-turn `patch_generated` git diff. */
  private renderAggregateDiff(event: ExcaliburEvent): void {
    const diff = s(event, 'diff');
    const affected = Array.isArray(event.payload['filesAffected'])
      ? (event.payload['filesAffected'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    if (diff.trim().length === 0 && affected.length === 0) {
      return;
    }
    const label = `${affected.length} file${affected.length === 1 ? '' : 's'} changed`;
    this.ui.write(`  ${pc.cyan(this.g('⏺', '*'))} ${'Diff'.padEnd(VERB_WIDTH)} ${pc.dim(label)}`.trimEnd());
    for (const line of this.diffLines(diff)) {
      this.ui.write(line);
    }
  }

  /** Colors a unified diff body with a +/− gutter, skipping headers, capped. */
  private diffLines(diff: string): string[] {
    if (diff.trim().length === 0) {
      return [];
    }
    const out: string[] = [];
    let shown = 0;
    let hidden = 0;
    for (const raw of diff.split('\n')) {
      if (
        raw.startsWith('diff ') ||
        raw.startsWith('index ') ||
        raw.startsWith('--- ') ||
        raw.startsWith('+++ ') ||
        raw.startsWith('@@') ||
        raw.startsWith('new file') ||
        raw.startsWith('deleted file')
      ) {
        continue; // structural lines — the gutter shows the content
      }
      if (raw.length === 0) {
        continue;
      }
      if (shown >= BODY_CAP) {
        hidden += 1;
        continue;
      }
      if (raw.startsWith('+')) {
        out.push(`    ${pc.green(raw)}`);
        shown += 1;
      } else if (raw.startsWith('-')) {
        out.push(`    ${pc.red(raw)}`);
        shown += 1;
      }
      // context lines are skipped to keep the live view tight
    }
    if (hidden > 0) {
      out.push(pc.dim(`    … +${hidden} more diff lines · /changes`));
    }
    return out;
  }

  /** Prints the model's pending narration (prose said BEFORE a tool call). */
  private flushNarration(): void {
    if (this.narration !== null && this.narration.length > 0) {
      this.ui.write(pc.dim(`  ${truncateLine(this.narration, 200)}`));
    }
    this.narration = null;
  }

  /** Discards pending narration (it was the final answer → receipt handles it). */
  private dropNarration(): void {
    this.narration = null;
  }

  /** Writes a result line and clears the pending call. */
  private closeWithResult(line: string): void {
    this.ui.write(line);
    this.pending = null;
  }
}

// --- formatting helpers ------------------------------------------------------

/** Line count of a tool result string (0 for empty). */
function countLines(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split('\n').length;
}

/** Last `max` non-empty lines of output (the useful tail), truncated for width. */
function tailLines(text: string, max: number): string[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.slice(Math.max(0, lines.length - max)).map((l) => truncateLine(l, 100));
}

/** Truncates a single line with an ellipsis. */
function truncateLine(line: string, max: number): string {
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Human elapsed time, or '' when unknown/instant. */
function formatElapsed(ms: number | null): string {
  if (ms === null || ms < 200) {
    return '';
  }
  return ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`;
}
