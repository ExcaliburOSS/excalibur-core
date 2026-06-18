import { render, useInput, useStdin } from 'ink';
import { useMemo, useSyncExternalStore, type ReactElement } from 'react';
import type { ExcaliburEvent } from '@excalibur/shared';
import type { ColorTier } from '../color.js';
import type { Palette, ThemeMode } from '../theme.js';
import { reduceRail, type ReduceRailOptions } from '../rail-reducer.js';
import type { ApprovalPrompt } from '../rail-types.js';
import { ThemeProvider } from './ThemeContext.js';
import { RunView, type RunViewLabels } from './RunView.js';
import { applyRunViewKey, createRunViewStore, type ApprovalAnswer, type RunViewStore } from './store.js';

/**
 * `mountRunView` — the bridge the CLI calls to render a live run with Ink. It
 * owns the event store, the spinner/clock tick and the keyboard (ESC → abort;
 * y/n/a → approval; space → toggle diffs), and returns a small imperative handle
 * the agent loop drives. The CLI mounts it on the TTY branch for the lifetime of
 * a run/turn and `unmount()`s at the end, which fully releases stdin so the
 * readline prompt can re-take it.
 */

export interface MountRunViewOptions {
  palette: Palette;
  tier: ColorTier;
  mode?: ThemeMode;
  /** Status-line context (autonomy/safety/model/push) folded into the model. */
  reduce?: ReduceRailOptions;
  labels?: RunViewLabels;
  /** Wall-clock source (injectable for tests). */
  now?: () => number;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** Spinner/clock tick interval; 0 disables (tests). Default 120ms. */
  tickMs?: number;
}

export interface RunViewHandle {
  push(event: ExcaliburEvent): void;
  /** Show an approval; resolves once the user answers. */
  requestApproval(approval: ApprovalPrompt): Promise<ApprovalAnswer>;
  /** Register an ESC handler (the turn's abort); returns an unsubscribe. */
  onEscape(listener: () => void): () => void;
  waitForExit(): Promise<void>;
  unmount(): void;
}

function Keys({ store }: { store: RunViewStore }): null {
  // Only bind input where raw mode is available; otherwise stay inert (Ink's
  // useInput would otherwise throw on a non-TTY stdin).
  const { isRawModeSupported } = useStdin();
  useInput(
    (input, key) => {
      applyRunViewKey(store, input, key);
    },
    { isActive: isRawModeSupported },
  );
  return null;
}

function RunViewApp({
  store,
  options,
}: {
  store: RunViewStore;
  options: MountRunViewOptions;
}): ReactElement {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const now = options.now ?? Date.now;
  const model = useMemo(
    () => reduceRail(snapshot.events, { ...(options.reduce ?? {}), nowMs: now() }),
    // Re-fold when the event log grows or the clock ticks (spinner/elapsed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot.events, snapshot.frame],
  );
  return (
    <ThemeProvider colors={options.palette}>
      <RunView
        model={model}
        spinnerFrame={snapshot.frame}
        approval={snapshot.approval}
        diffsExpanded={snapshot.diffsExpanded}
        tier={options.tier}
        {...(options.mode !== undefined ? { mode: options.mode } : {})}
        {...(options.labels !== undefined ? { labels: options.labels } : {})}
      />
      <Keys store={store} />
    </ThemeProvider>
  );
}

export function mountRunView(options: MountRunViewOptions): RunViewHandle {
  const store = createRunViewStore();
  const instance = render(<RunViewApp store={store} options={options} />, {
    stdout: options.stdout ?? process.stdout,
    stdin: options.stdin ?? process.stdin,
    // Our AbortController owns Ctrl-C; route stray console.* through Ink so a
    // log never tears the frame (restored on unmount).
    exitOnCtrlC: false,
    patchConsole: true,
  });
  const tickMs = options.tickMs ?? 120;
  let timer: ReturnType<typeof setInterval> | null = null;
  if (tickMs > 0) {
    timer = setInterval(() => store.tick(), tickMs);
    timer.unref();
  }
  return {
    push: (event) => store.push(event),
    requestApproval: (approval) => store.requestApproval(approval),
    onEscape: (listener) => store.onEscape(listener),
    waitForExit: () => instance.waitUntilExit(),
    unmount: () => {
      if (timer !== null) clearInterval(timer);
      instance.unmount();
    },
  };
}
