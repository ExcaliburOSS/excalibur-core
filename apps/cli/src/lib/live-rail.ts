import type { ExcaliburEvent } from '@excalibur/shared';
import {
  reduceRail,
  renderRail,
  stripAnsi,
  type ColorTier,
  type Palette,
  type ReduceRailOptions,
  type ThemeMode,
} from '@excalibur/tui';

const ANSI_SEQ = /^\x1b\[[0-9;]*m/;

/**
 * Clamps a rendered line to `columns` VISIBLE characters (ANSI color codes don't
 * count and are preserved), so a line never wraps onto a second physical row.
 * The differential redraw counts logical lines as physical rows when moving the
 * cursor — a wrapped line would throw that off and corrupt the in-place repaint.
 */
export function clampVisibleWidth(line: string, columns: number): string {
  if (columns <= 0 || stripAnsi(line).length <= columns) {
    return line;
  }
  let visible = 0;
  let out = '';
  let i = 0;
  while (i < line.length && visible < columns) {
    const seq = ANSI_SEQ.exec(line.slice(i));
    if (seq) {
      out += seq[0];
      i += seq[0].length;
      continue;
    }
    out += line[i];
    visible += 1;
    i += 1;
  }
  return `${out}\x1b[0m`; // reset so a truncated color never bleeds onward
}

/**
 * The LIVING RAIL, live. On a TTY this redraws the whole rail block IN PLACE as
 * each `ExcaliburEvent` arrives (and on a timer, so the active spinner breathes
 * between events) — the rail fills with green as phases complete, exactly the
 * north-star behaviour that beats the append-only chat logs of CC/OpenCode.
 *
 * It folds the SAME `reduceRail` the post-run summary and a replay use, so the
 * live view is byte-identical to a later scrub. On a non-TTY stdout the caller
 * streams plain lines instead (this class is only constructed for a TTY).
 *
 * The cursor is parked at the column-0 line *below* the rail between frames; a
 * redraw moves up `lastLineCount` rows, clears to end of screen, and reprints.
 */

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

// DEC 2026 synchronized output: the terminal BUFFERS everything between BEGIN
// and END and presents the frame ATOMICALLY, so the clear→reprint is never
// shown half-done → zero tearing/flicker. Terminals that don't support it
// silently ignore the private-mode set (graceful degradation), so we emit it
// unconditionally — the same approach Ghostty/Kitty/Ink use.
const SYNC_BEGIN = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

export interface LiveRailSink {
  /** Writes raw bytes with NO added newline (ANSI control + content). */
  writeRaw(text: string): void;
}

export interface LiveRailOptions {
  tier: ColorTier;
  mode: ThemeMode;
  /** Explicit palette (a named theme preset); wins over `mode` when provided. */
  palette?: Palette;
  /** Forwarded to `reduceRail` (autonomyLabel/safety/model/push). */
  reduce: ReduceRailOptions;
  /** Animate the spinner on a timer between events (default true). */
  animate?: boolean;
  /** Wrap frames in DEC 2026 synchronized output for zero flicker (default true). */
  sync?: boolean;
  /** Wall-clock source for the ticking elapsed (injectable for tests). */
  now?: () => number;
  /** Localized rail status words (i18n) forwarded to `renderRail`. */
  labels?: { push?: string; noPush?: string; tasks?: string };
  /**
   * Terminal width for clamping rail lines so none wraps (which would break the
   * differential redraw's row math). Defaults to `process.stdout.columns`,
   * re-read every frame so a resize is honored. Injectable for tests.
   */
  columns?: () => number;
}

export class LiveRail {
  private readonly events: ExcaliburEvent[] = [];
  private lastLineCount = 0;
  /** The lines of the last painted frame, for differential (changed-only) redraw. */
  private prevLines: string[] = [];
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private paused = false;

  constructor(
    private readonly sink: LiveRailSink,
    private readonly options: LiveRailOptions,
  ) {}

  /** Hides the cursor and (unless disabled) starts the spinner animation tick. */
  start(): void {
    this.sink.writeRaw(HIDE_CURSOR);
    if (this.options.animate !== false) {
      this.timer = setInterval(() => this.render(), 120);
      // Never keep the event loop alive just for the spinner.
      this.timer.unref?.();
    }
    this.render();
  }

  /** Accepts the next event and repaints the frame (unless paused). */
  push(event: ExcaliburEvent): void {
    if (this.stopped) return;
    this.events.push(event);
    if (!this.paused) this.render();
  }

  /**
   * Settles the current frame and suspends redraws so an interactive prompt
   * (an approval `confirm`) can print below it cleanly. Events keep
   * accumulating; {@link resume} repaints a fresh block under the prompt.
   */
  pause(): void {
    if (this.stopped || this.paused) return;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.paused = true;
    this.lastLineCount = 0; // the next frame starts a new block below the prompt
    this.prevLines = []; // forget the old frame — resume repaints whole
    this.sink.writeRaw(`${SHOW_CURSOR}\n`);
  }

  /** Resumes live redraws after a paused prompt, repainting a fresh frame. */
  resume(): void {
    if (this.stopped || !this.paused) return;
    this.paused = false;
    this.sink.writeRaw(HIDE_CURSOR);
    if (this.options.animate !== false) {
      this.timer = setInterval(() => this.render(), 120);
      this.timer.unref?.();
    }
    this.render();
  }

  /** Paints the final frame, stops the tick and restores the cursor. */
  stop(): void {
    if (this.stopped) return;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.paused = false; // ensure the final frame paints even if mid-prompt
    this.render();
    this.stopped = true;
    this.sink.writeRaw(SHOW_CURSOR);
  }

  /**
   * Builds the current frame and writes it as a FLICKER-FREE in-place redraw:
   * the whole frame is wrapped in DEC 2026 synchronized output (atomic present)
   * AND only the lines that actually changed are repainted — we find the first
   * line that differs from the last frame and repaint from there down, so the
   * stable top (header + completed phases) is never cleared or rewritten. An
   * identical frame is skipped entirely. Cursor is parked one line below the rail.
   */
  private render(): void {
    this.frame += 1;
    const now = this.options.now ?? Date.now;
    const model = reduceRail(this.events, { ...this.options.reduce, nowMs: now() });
    const rawLines = renderRail(model, {
      tier: this.options.tier,
      mode: this.options.mode,
      ...(this.options.palette !== undefined ? { palette: this.options.palette } : {}),
      spinnerFrame: this.frame,
      ...(this.options.labels !== undefined ? { labels: this.options.labels } : {}),
    });
    // Clamp to the terminal width so no line wraps onto a second physical row
    // (the redraw moves the cursor by LOGICAL line count = physical rows only
    // when nothing wraps).
    const columns = this.options.columns?.() ?? process.stdout.columns ?? 0;
    const lines = columns > 0 ? rawLines.map((line) => clampVisibleWidth(line, columns)) : rawLines;
    const begin = this.options.sync !== false ? SYNC_BEGIN : '';
    const end = this.options.sync !== false ? SYNC_END : '';

    // Fresh block (first frame / after pause): write it whole.
    if (this.lastLineCount === 0) {
      this.sink.writeRaw(`${begin}${lines.join('\n')}\n${end}`);
      this.prevLines = lines;
      this.lastLineCount = lines.length;
      return;
    }

    // Find the first line that changed from the last frame.
    let from = 0;
    const common = Math.min(this.prevLines.length, lines.length);
    while (from < common && this.prevLines[from] === lines[from]) {
      from += 1;
    }
    // Identical frame → nothing to do (skip the write; no redundant repaint).
    if (from === lines.length && lines.length === this.prevLines.length) {
      return;
    }

    // Move up from the parked line (row = lastLineCount) to the first changed
    // row, clear from there to end of screen (handles a shrunk rail), reprint the
    // tail. `\x1b[0A` is ambiguous (≈ 1A), so omit the move when already at `from`.
    const upBy = this.lastLineCount - from;
    const up = upBy > 0 ? `\x1b[${upBy}A` : '';
    const tail = lines.slice(from);
    const body = tail.join('\n');
    this.sink.writeRaw(`${begin}${up}\r\x1b[0J${body}${tail.length > 0 ? '\n' : ''}${end}`);
    this.prevLines = lines;
    this.lastLineCount = lines.length;
  }
}
