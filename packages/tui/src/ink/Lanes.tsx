import { Box, render, Text } from 'ink';
import { useSyncExternalStore, type ReactElement } from 'react';
import type { ColorTier } from '../color.js';
import {
  renderLanes,
  type LaneModel,
  type LanesModel,
  type RenderLanesOptions,
} from '../rail-lanes.js';
import type { Palette, ThemeMode } from '../theme.js';

/**
 * The swarm LANES panel, rendered with Ink: N parallel agents lighting up
 * empty → running → done/failed as each works in its own worktree. Output-ONLY
 * (no `useInput`), so Ink never grabs raw mode — the panel coexists with the
 * REPL's editor (which keeps ESC-to-cancel) without a stdin handoff. Reuses the
 * pure `renderLanes` and passes its pre-coloured lines straight through.
 */

export interface LanesViewLabels {
  swarm?: string;
  lanes?: string;
  merge?: string;
  applied?: string;
  conflict?: string;
}

/** A lane-progress signal (structurally `SwarmLaneProgress`, no core import). */
export interface LaneProgress {
  index: number;
  phase: 'started' | 'settled';
  failed?: boolean;
}

interface LanesSnapshot {
  model: LanesModel;
}

export interface LanesStore {
  getSnapshot(): LanesSnapshot;
  subscribe(listener: () => void): () => void;
  update(progress: LaneProgress): void;
  setModel(model: LanesModel): void;
}

export function createLanesStore(lanes: ReadonlyArray<{ id: string; title: string }>): LanesStore {
  let snapshot: LanesSnapshot = {
    model: {
      lanes: lanes.map((l): LaneModel => ({ id: l.id, title: l.title, state: 'empty' })),
      applied: 0,
      conflicts: 0,
    },
  };
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(progress) {
      const lanes2 = snapshot.model.lanes.map((lane, index) =>
        index === progress.index
          ? {
              ...lane,
              state:
                progress.phase === 'started'
                  ? ('running' as const)
                  : progress.failed === true
                    ? ('failed' as const)
                    : ('done' as const),
            }
          : lane,
      );
      snapshot = { model: { ...snapshot.model, lanes: lanes2 } };
      emit();
    },
    setModel(model) {
      snapshot = { model };
      emit();
    },
  };
}

function LanesView(props: {
  store: LanesStore;
  tier: ColorTier;
  palette: Palette;
  mode?: ThemeMode;
  labels?: LanesViewLabels;
}): ReactElement {
  const snapshot = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot);
  const options: RenderLanesOptions = {
    tier: props.tier,
    palette: props.palette,
    ...(props.mode !== undefined ? { mode: props.mode } : {}),
    ...(props.labels !== undefined ? { labels: props.labels } : {}),
  };
  const lines = renderLanes(snapshot.model, options);
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index}>{line}</Text>
      ))}
    </Box>
  );
}

export interface MountLanesViewOptions {
  palette: Palette;
  tier: ColorTier;
  mode?: ThemeMode;
  lanes: ReadonlyArray<{ id: string; title: string }>;
  labels?: LanesViewLabels;
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
}

export interface LanesViewHandle {
  /** Fold a lane-progress signal (empty → running → done/failed) and repaint. */
  update(progress: LaneProgress): void;
  /** Swap in the final detailed model (per-lane diffstat/cost + merge counts). */
  setFinal(model: LanesModel): void;
  unmount(): void;
}

export function mountLanesView(options: MountLanesViewOptions): LanesViewHandle {
  const store = createLanesStore(options.lanes);
  const instance = render(
    <LanesView
      store={store}
      tier={options.tier}
      palette={options.palette}
      {...(options.mode !== undefined ? { mode: options.mode } : {})}
      {...(options.labels !== undefined ? { labels: options.labels } : {})}
    />,
    {
      stdout: options.stdout ?? process.stdout,
      stdin: options.stdin ?? process.stdin,
      exitOnCtrlC: false,
      // Output-only panel (no useInput): don't globally patch console — the
      // swarm can run from inside the REPL, where hijacking console.* for the
      // panel's lifetime (and leaving it patched on an early throw) is unwanted.
      patchConsole: false,
    },
  );
  return {
    update: (progress) => store.update(progress),
    setFinal: (model) => store.setModel(model),
    unmount: () => instance.unmount(),
  };
}
