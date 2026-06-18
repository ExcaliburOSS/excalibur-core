import type { ExcaliburEvent } from '@excalibur/shared';
import {
  detectColorTier,
  detectThemeSync,
  getColors,
  paint,
  renderTodos,
  stripAnsi,
  type ColorTier,
  type Palette,
  type TodoItem,
} from '@excalibur/tui';
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

/**
 * The grounded present-continuous activity for an in-flight event, used as the
 * thinking-indicator label DURING the wait that follows it — `Running npm test`
 * while a command runs, `Editing charge.ts` while a write lands. Returns null
 * when the event implies no specific activity (the caller falls back to a
 * phase/role gerund like "Implementing…").
 */
export function activityFor(event: ExcaliburEvent): string | null {
  if (event.type !== 'tool_call' || !('arguments' in event.payload)) {
    return null;
  }
  const tool = s(event, 'tool') || s(event, 'name');
  const args = (event.payload['arguments'] as Record<string, unknown> | undefined) ?? {};
  const target = targetFor(tool, args);
  switch (tool) {
    case 'read_file':
      return target ? `Reading ${target}` : 'Reading';
    case 'write_file':
      return target ? `Editing ${target}` : 'Editing';
    case 'list_files':
      return target ? `Listing ${target}` : 'Listing';
    case 'search_code':
      return target ? `Searching ${target}` : 'Searching';
    case 'run_command':
    case 'run_tests':
      return target ? `Running ${target}` : 'Running';
    case 'git_diff':
      return 'Diffing';
    case 'apply_patch':
      return 'Applying patch';
    case 'create_branch':
      return target ? `Creating branch ${target}` : 'Creating branch';
    default:
      return tool ? `${tool}` : null;
  }
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
  private readonly t: CliDeps['t'];
  private readonly unicode: boolean;
  private readonly clock: () => number;
  // The interactive shell shares the rail's colour identity: the same truecolor
  // accent + semantic palette, downsampled to the terminal's capability, with
  // light/dark auto-detection. On a non-TTY (CI/tests) the tier is `none`, so
  // every paint() returns plain text — exactly how picocolors degraded before.
  private readonly tier: ColorTier;
  private readonly palette: Palette;
  private pending: PendingCall | null = null;
  private narration: string | null = null;

  constructor(deps: CliDeps, options: ActionRendererOptions = {}) {
    this.ui = deps.ui;
    this.t = deps.t;
    this.unicode = options.unicode ?? true;
    this.clock = options.clock ?? ((): number => Date.now());
    this.tier = detectColorTier(process.env, deps.ui.isOutputTty());
    this.palette = getColors(detectThemeSync() ?? 'dark');
  }

  /** Paints `text` in the palette colour, or returns it plain when colour is off. */
  private c(text: string, hex: string): string {
    return this.tier === 'none' ? text : paint(text, hex, this.tier);
  }

  private g(unicode: string, ascii: string): string {
    return this.unicode ? unicode : ascii;
  }

  /** Feed one streamed event. Renders incrementally; safe on any event order. */
  onEvent(event: ExcaliburEvent): void {
    switch (event.type) {
      case 'phase_started':
        this.dropNarration();
        this.ui.write(this.c(`${this.g('▸', '>')} ${s(event, 'name') || this.t('action-render.phase')}`, this.palette.accent));
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
        } else if ((s(event, 'tool') || s(event, 'name')) === 'update_tasks') {
          // Don't announce the checklist tool as a generic call — the
          // `task_update` event that follows renders the proper band.
          this.dropNarration();
        } else {
          this.startCall(event);
        }
        return;
      case 'task_update': {
        // The live checklist: render the proper band (not a bare tool block).
        this.dropNarration();
        const raw = Array.isArray(event.payload['tasks'])
          ? (event.payload['tasks'] as unknown[])
          : [];
        const todos: TodoItem[] = raw.map((item) => {
          const tk = (item ?? {}) as { text?: unknown; status?: unknown };
          return {
            text: typeof tk.text === 'string' ? tk.text : '',
            status:
              tk.status === 'in_progress' || tk.status === 'completed' ? tk.status : 'pending',
          };
        });
        for (const line of renderTodos(todos, {
          tier: this.tier,
          mode: detectThemeSync() ?? 'dark',
          label: this.t('rail.tasks'),
        })) {
          this.ui.write(line);
        }
        return;
      }
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
          this.writeNotice(stripAnsi(s(event, 'message')) || this.t('action-render.declined'), this.palette.warn);
        }
        return;
      case 'error':
        this.writeNotice(this.t('action-render.error', { message: stripAnsi(s(event, 'message')) }), this.palette.danger);
        return;
      case 'verification': {
        this.dropNarration();
        const blocked = event.payload['blocked'] === true;
        const hex = blocked ? this.palette.danger : this.palette.success;
        this.ui.write(`  ${this.c(this.g('⚖', '!'), hex)} ${this.c(s(event, 'summary'), hex)}`.trimEnd());
        return;
      }
      case 'claim': {
        this.dropNarration();
        const status = s(event, 'status');
        const hex =
          status === 'refuted'
            ? this.palette.danger
            : status === 'verified'
              ? this.palette.success
              : this.palette.muted;
        this.ui.write(
          `  ${this.c(this.g('⊨', '='), hex)} ${this.c(`${s(event, 'statement')} — ${status}`, hex)}`.trimEnd(),
        );
        return;
      }
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
    const head = `  ${this.c(this.g('⏺', '*'), this.palette.accent)} ${verb.padEnd(VERB_WIDTH)} ${this.c(target, this.palette.muted)}`.trimEnd();
    this.ui.write(head);
  }

  /** Renders the result body of the pending (or just-seen) tool call. */
  private renderResult(event: ExcaliburEvent): void {
    const tool = s(event, 'tool') || s(event, 'name');
    const ok = event.payload['ok'] !== false;
    const elapsed = this.pending !== null ? this.clock() - this.pending.startedAtMs : null;
    const args = this.pending?.args ?? {};

    if (!ok) {
      // The result may carry its OWN ANSI (e.g. a colored test runner): strip it
      // first so its reset codes don't terminate the danger color mid-line.
      const reason = stripAnsi(s(event, 'result')) || this.t('action-render.failed');
      this.closeWithResult(`${this.indent()} ${this.c(reason, this.palette.danger)}`);
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
    return `    ${this.c(this.g('⎿', 'L'), this.palette.muted)}`;
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
        return [`${this.indent()} ${this.c(this.t('action-render.lines', { count: lines, plural: lines === 1 ? '' : 's' }), this.palette.muted)}`];
      }
      case 'list_files': {
        const n = countLines(s(event, 'result'));
        const entries = n === 1 ? this.t('action-render.entriesOne', { count: n }) : this.t('action-render.entriesMany', { count: n });
        return [`${this.indent()} ${this.c(entries, this.palette.muted)}`];
      }
      case 'search_code': {
        const n = countLines(s(event, 'result'));
        const matches = n === 1 ? this.t('action-render.matchesOne', { count: n }) : this.t('action-render.matchesMany', { count: n });
        return [`${this.indent()} ${this.c(matches, this.palette.muted)}`];
      }
      case 'write_file': {
        const note = s(event, 'result') || this.t('action-render.written');
        return [`${this.indent()} ${this.c(note, this.palette.muted)}`];
      }
      case 'create_branch':
        return [`${this.indent()} ${this.c(this.t('action-render.branch', { name: s(event, 'branch') }), this.palette.muted)}`];
      case 'run_command':
      case 'run_tests': {
        const exit = typeof event.payload['exitCode'] === 'number' ? (event.payload['exitCode'] as number) : null;
        const meta = [exit !== null ? `exit ${exit}` : null, elapsed].filter(Boolean).join(' · ');
        // The TAIL of the output is the useful part (test summary / error), not
        // the boilerplate banner at the top.
        const tail = tailLines(s(event, 'result'), 2);
        if (tail.length === 0) {
          return [`${this.indent()} ${this.c(meta || this.t('action-render.done'), this.palette.muted)}`];
        }
        const first = `${this.indent()} ${tail[0]}${meta ? `   ${this.c(meta, this.palette.muted)}` : ''}`;
        const rest = tail.slice(1).map((l) => `      ${this.c(l, this.palette.muted)}`);
        return [first, ...rest];
      }
      case 'git_diff':
        return this.diffLines(s(event, 'result'));
      case 'apply_patch': {
        const diff = typeof args['diff'] === 'string' ? (args['diff'] as string) : '';
        const head = this.diffLines(diff);
        return head.length > 0 ? head : [`${this.indent()} ${this.c(this.t('action-render.applied'), this.palette.muted)}`];
      }
      default:
        return [`${this.indent()} ${this.c(s(event, 'result') || this.t('action-render.done'), this.palette.muted)}`];
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
    const label = this.t('action-render.filesChanged', {
      count: affected.length,
      plural: affected.length === 1 ? '' : 's',
    });
    this.ui.write(`  ${this.c(this.g('⏺', '*'), this.palette.accent)} ${'Diff'.padEnd(VERB_WIDTH)} ${this.c(label, this.palette.muted)}`.trimEnd());
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
      // Only +/− lines are rendered; context lines are skipped to keep the live
      // view tight — so they must NOT inflate the "N more diff lines" count.
      const isChange = raw.startsWith('+') || raw.startsWith('-');
      if (!isChange) {
        continue;
      }
      if (shown >= BODY_CAP) {
        hidden += 1;
        continue;
      }
      out.push(`    ${this.c(raw, raw.startsWith('+') ? this.palette.success : this.palette.danger)}`);
      shown += 1;
    }
    if (hidden > 0) {
      out.push(this.c(`    … ${this.t('action-render.moreDiffLines', { count: hidden })} · /changes`, this.palette.muted));
    }
    return out;
  }

  /** Prints the model's pending narration (prose said BEFORE a tool call). */
  private flushNarration(): void {
    if (this.narration !== null && this.narration.length > 0) {
      this.ui.write(this.c(`  ${truncateLine(this.narration, 200)}`, this.palette.muted));
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

  /**
   * Renders an error/decline notice. When a tool call is OPEN it attaches as the
   * call's `⎿` result; otherwise it stands alone with a top-level glyph — never
   * a dangling `⎿` connector pointing at no header above it.
   */
  private writeNotice(message: string, hex: string): void {
    if (this.pending !== null) {
      this.closeWithResult(`    ${this.c(this.g('⎿', 'L'), hex)} ${this.c(message, hex)}`);
    } else {
      this.ui.write(`  ${this.c(this.g('✗', 'x'), hex)} ${this.c(message, hex)}`.trimEnd());
    }
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
