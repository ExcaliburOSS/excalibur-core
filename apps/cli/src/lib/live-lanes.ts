import type { SwarmLaneProgress } from '@excalibur/core';
import {
  renderLanes,
  type ColorTier,
  type LaneModel,
  type Palette,
  type ThemeMode,
} from '@excalibur/tui';

/**
 * The swarm LANES panel, LIVE. On a TTY it redraws the panel in place as each
 * lane transitions empty → running → done/failed (driven by runSwarm's
 * {@link SwarmLaneProgress} hook), so the user watches N agents work IN PARALLEL
 * — beating CC's stacked-one-at-a-time and OpenCode's paginated view. Frames are
 * wrapped in DEC 2026 synchronized output for atomic, flicker-free paint (the
 * same lever as {@link LiveRail}). On `finish()` the live panel is erased so the
 * caller can print the final detailed panel (with per-lane diffstat/cost/merge).
 */

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const SYNC_BEGIN = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

export interface LiveLanesSink {
  writeRaw(text: string): void;
}

export interface LiveLanesOptions {
  tier: ColorTier;
  mode: ThemeMode;
  palette?: Palette;
  /** The lanes to track, in fan-out order. */
  lanes: ReadonlyArray<{ id: string; title: string }>;
  labels?: { swarm?: string; lanes?: string; merge?: string; applied?: string; conflict?: string };
  /** Wrap frames in synchronized output (default true). */
  sync?: boolean;
}

export class LiveLanes {
  private readonly lanes: LaneModel[];
  private lastLineCount = 0;
  private stopped = false;

  constructor(
    private readonly sink: LiveLanesSink,
    private readonly options: LiveLanesOptions,
  ) {
    this.lanes = options.lanes.map((l) => ({ id: l.id, title: l.title, state: 'empty' }));
  }

  start(): void {
    this.sink.writeRaw(HIDE_CURSOR);
    this.render();
  }

  /** Folds a lane-progress signal into the panel and repaints. */
  update(progress: SwarmLaneProgress): void {
    if (this.stopped) return;
    const lane = this.lanes[progress.index];
    if (lane !== undefined) {
      lane.state =
        progress.phase === 'started' ? 'running' : progress.failed === true ? 'failed' : 'done';
    }
    this.render();
  }

  /** Erases the live panel and restores the cursor (caller prints the final one). */
  finish(): void {
    if (this.stopped) return;
    this.stopped = true;
    const moveUp = this.lastLineCount > 0 ? `\x1b[${this.lastLineCount}A\x1b[0J` : '';
    this.sink.writeRaw(`${moveUp}${SHOW_CURSOR}`);
  }

  private render(): void {
    const begin = this.options.sync !== false ? SYNC_BEGIN : '';
    const end = this.options.sync !== false ? SYNC_END : '';
    const lines = renderLanes(
      { lanes: this.lanes, applied: 0, conflicts: 0 },
      {
        tier: this.options.tier,
        mode: this.options.mode,
        ...(this.options.palette !== undefined ? { palette: this.options.palette } : {}),
        ...(this.options.labels !== undefined ? { labels: this.options.labels } : {}),
      },
    );
    const moveUp = this.lastLineCount > 0 ? `\x1b[${this.lastLineCount}A\x1b[0J` : '';
    this.sink.writeRaw(`${begin}${moveUp}${lines.join('\n')}\n${end}`);
    this.lastLineCount = lines.length;
  }
}
