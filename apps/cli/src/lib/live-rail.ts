import type { ExcaliburEvent } from '@excalibur/shared';
import {
  reduceRail,
  renderRail,
  type ColorTier,
  type ReduceRailOptions,
  type ThemeMode,
} from '@excalibur/tui';

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

export interface LiveRailSink {
  /** Writes raw bytes with NO added newline (ANSI control + content). */
  writeRaw(text: string): void;
}

export interface LiveRailOptions {
  tier: ColorTier;
  mode: ThemeMode;
  /** Forwarded to `reduceRail` (autonomyLabel/safety/model/push). */
  reduce: ReduceRailOptions;
  /** Animate the spinner on a timer between events (default true). */
  animate?: boolean;
  /** Wall-clock source for the ticking elapsed (injectable for tests). */
  now?: () => number;
  /** Localized rail status words (i18n) forwarded to `renderRail`. */
  labels?: { push?: string; noPush?: string; tasks?: string };
}

export class LiveRail {
  private readonly events: ExcaliburEvent[] = [];
  private lastLineCount = 0;
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

  /** Builds the current frame and writes it as an in-place redraw. */
  private render(): void {
    this.frame += 1;
    const now = this.options.now ?? Date.now;
    const model = reduceRail(this.events, { ...this.options.reduce, nowMs: now() });
    const lines = renderRail(model, {
      tier: this.options.tier,
      mode: this.options.mode,
      spinnerFrame: this.frame,
      ...(this.options.labels !== undefined ? { labels: this.options.labels } : {}),
    });
    // Move up over the previous frame and clear everything from there down, then
    // reprint. Leaves the cursor parked one line below the rail.
    const moveUp = this.lastLineCount > 0 ? `\x1b[${this.lastLineCount}A\x1b[0J` : '';
    this.sink.writeRaw(`${moveUp}${lines.join('\n')}\n`);
    this.lastLineCount = lines.length;
  }
}
