import { accent } from './accent';

/**
 * A transient single-line "thinking/working" indicator (the M-Shell
 * `<ThinkingIndicator>`, line-based precursor to the Ink version).
 *
 * It owns the CURRENT terminal line: each tick rewrites it in place (carriage
 * return + clear-to-end), and `stop()` erases it so the next PERMANENT line (an
 * action block, the receipt, a prompt) renders cleanly. The caller supplies a
 * `render()` that returns the grounded text — the real activity ("Running tests
 * · npm test") when known, a phase/role gerund ("Implementing…") when the model
 * is just reasoning — plus live `tok · $cost · elapsed`; the spinner only
 * prepends the breathing braille glyph.
 *
 * It is ACTIVE only on a real TTY stdout (`enabled`). On a piped/CI stream or the
 * in-memory test stdout (`isTTY` falsy) every method is a no-op — no timers, no
 * ANSI noise — so logs stay clean and tests never see a spinner.
 */

const FRAMES_UNICODE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAMES_ASCII = ['-', '\\', '|', '/'];
const DEFAULT_INTERVAL_MS = 90;

// Built from char codes to avoid embedding raw control bytes in source literals.
const CR = String.fromCharCode(13); // carriage return → column 0
const ESC = String.fromCharCode(27); // escape
const CLEAR_LINE = `${CR}${ESC}[2K`; // CR + "erase entire line"

export interface SpinnerOptions {
  /** Active only when true (a real TTY). Non-TTY → every method is a no-op. */
  enabled: boolean;
  /** Braille frames vs ASCII fallback. */
  unicode?: boolean;
  intervalMs?: number;
}

export class Spinner {
  private readonly stdout: NodeJS.WritableStream;
  private readonly enabled: boolean;
  private readonly frames: readonly string[];
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private render: (() => string) | null = null;
  /** Whether a frame is currently on screen (so stop() only erases its OWN line). */
  private active = false;
  /** Once cancelled (e.g. on Ctrl-C), stays stopped — start() becomes a no-op. */
  private cancelled = false;

  constructor(stdout: NodeJS.WritableStream, options: SpinnerOptions) {
    this.stdout = stdout;
    this.enabled = options.enabled;
    this.frames = options.unicode === false ? FRAMES_ASCII : FRAMES_UNICODE;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /** Starts (or re-targets) the indicator with a text supplier. No-op when disabled. */
  start(render: () => string): void {
    if (!this.enabled || this.cancelled) {
      return;
    }
    this.render = render;
    if (this.timer === null) {
      this.timer = setInterval(() => this.tick(), this.intervalMs);
      // Never keep the process alive just for the spinner.
      const handle = this.timer as { unref?: () => void };
      if (typeof handle.unref === 'function') {
        handle.unref();
      }
    }
    this.tick();
  }

  /** Stops the indicator and ERASES its line so the next write starts clean. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.enabled && this.active) {
      this.stdout.write(CLEAR_LINE);
    }
    this.active = false;
    this.render = null;
    // Keep `this.frame` so a stop→start cycle (around a permanent write) keeps
    // the braille spinning smoothly rather than resetting to the first frame.
  }

  /**
   * Permanently stops the indicator and erases its line, RIGHT NOW — for Ctrl-C:
   * the SIGINT handler aborts cooperatively (the run loop may keep awaiting the
   * in-flight model call for seconds), so the indicator must clear itself
   * synchronously here and never re-arm, or its next frame would overwrite the
   * "Cancelled" message. Safe to call from an abort listener.
   */
  cancel(): void {
    this.cancelled = true;
    this.stop();
  }

  private tick(): void {
    const glyph = this.frames[this.frame % this.frames.length] as string;
    this.frame += 1;
    const text = this.render !== null ? this.render() : '';
    this.stdout.write(`${CLEAR_LINE} ${accent(glyph)} ${text}`);
    this.active = true;
  }
}

/** True when a stream is a real TTY (so the spinner should animate). */
export function isTtyStream(stream: NodeJS.WritableStream): boolean {
  return (stream as { isTTY?: boolean }).isTTY === true;
}
