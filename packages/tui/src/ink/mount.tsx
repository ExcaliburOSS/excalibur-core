import { render, useInput, useStdin, useStdout } from 'ink';
import { useMemo, useSyncExternalStore, type ReactElement } from 'react';
import type { ExcaliburEvent } from '@excalibur/shared';
import type { ColorTier } from '../color.js';
import type { Palette, ThemeMode } from '../theme.js';
import { reduceRail, type ReduceRailOptions } from '../rail-reducer.js';
import type { ApprovalPrompt } from '../rail-types.js';
import { ThemeProvider } from './ThemeContext.js';
import { RunView, type RunViewLabels } from './RunView.js';
import { MissionRibbon } from './MissionRibbon.js';
import { PlanRibbon } from './PlanRibbon.js';
import type { MissionRibbonModel } from '../mission-ribbon.js';
import type { PlanRibbonModel } from '../plan-ribbon.js';
import {
  applyRunViewKey,
  createRunViewStore,
  type ApprovalAnswer,
  type RunViewStore,
} from './store.js';

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
  /** Slim the footer to time · tokens · cost (conversational m-shell sets this). */
  compactStatus?: boolean;
  /** Wall-clock source (injectable for tests). */
  now?: () => number;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** Spinner/clock tick interval; 0 disables (tests). Default 120ms. */
  tickMs?: number;
}

export interface RunViewHandle {
  push(event: ExcaliburEvent): void;
  /** Feed the live, still-streaming narration for the current turn (typed out). */
  streamNarration(text: string): void;
  /** Set/refresh the mission plan ribbon pinned above the rail (M8 #43). */
  setRibbon(model: MissionRibbonModel): void;
  /** Set/refresh the live plan ribbon (PLAN4) pinned above the rail. */
  setPlanRibbon(model: PlanRibbonModel): void;
  /** Clear the rail for a new capability (the ribbon stays). */
  resetEvents(): void;
  /** Show an approval; resolves once the user answers. */
  requestApproval(approval: ApprovalPrompt): Promise<ApprovalAnswer>;
  /** Register an ESC handler (the turn's abort); returns an unsubscribe. */
  onEscape(listener: () => void): () => void;
  /**
   * Arm the interrupt channel (INT-1): the listener receives a message the user
   * typed WHILE the run streamed (submitted with Enter). Registering it lets the
   * live view capture typed keys into a draft; returns an unsubscribe that
   * disarms the channel when the last handler goes.
   */
  onInterrupt(listener: (text: string) => void): () => void;
  /** Show the instant acknowledgment after an interrupt is routed (INT-1). */
  noticeInterrupt(text: string): void;
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
  const { stdout } = useStdout();
  const now = options.now ?? Date.now;
  // Fold the event log ONLY when it actually changes (eventsRev) — NOT every 120ms
  // frame. Re-folding the whole log on each tick produced a brand-new model object and
  // a full-subtree repaint 8×/second: the residual flicker (RUN-FIX-21). Keyed on
  // eventsRev, not the events array identity (it's mutated in place).
  const baseModel = useMemo(
    () => reduceRail(snapshot.events, { ...(options.reduce ?? {}), nowMs: now() }),
    [snapshot.eventsRev],
  );
  // Overlay the LIVE elapsed clock each frame WITHOUT re-folding: a cheap status spread
  // from the run's start anchor, so the clock still breathes between events (it would
  // otherwise freeze — the "58s congelado" the user saw). A finished run keeps its
  // frozen elapsed (no anchor update needed).
  const model = useMemo(() => {
    const startedAtMs = baseModel.status.startedAtMs;
    if (baseModel.done || startedAtMs === undefined) {
      return baseModel;
    }
    const elapsedMs = Math.max(0, now() - startedAtMs);
    if (elapsedMs === baseModel.status.elapsedMs) {
      return baseModel;
    }
    return { ...baseModel, status: { ...baseModel.status, elapsedMs } };
  }, [baseModel, snapshot.frame]);
  return (
    <ThemeProvider colors={options.palette}>
      {snapshot.missionRibbon !== null ? (
        <MissionRibbon model={snapshot.missionRibbon} spinnerFrame={snapshot.frame} />
      ) : null}
      {snapshot.planRibbon !== null ? (
        <PlanRibbon model={snapshot.planRibbon} spinnerFrame={snapshot.frame} />
      ) : null}
      <RunView
        model={model}
        spinnerFrame={snapshot.frame}
        approval={snapshot.approval}
        diffsExpanded={snapshot.diffsExpanded}
        streamingNarration={snapshot.streamingNarration}
        interruptDraft={snapshot.interruptDraft}
        interruptEnabled={snapshot.interruptEnabled}
        interruptNotice={snapshot.interruptNotice}
        tier={options.tier}
        width={stdout?.columns ?? 80}
        rows={stdout?.rows ?? 24}
        {...(options.mode !== undefined ? { mode: options.mode } : {})}
        {...(options.labels !== undefined ? { labels: options.labels } : {})}
        {...(options.compactStatus !== undefined ? { compactStatus: options.compactStatus } : {})}
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
    streamNarration: (text) => store.streamNarration(text),
    setRibbon: (model) => store.setRibbon(model),
    setPlanRibbon: (model) => store.setPlanRibbon(model),
    resetEvents: () => store.resetEvents(),
    requestApproval: (approval) => store.requestApproval(approval),
    onEscape: (listener) => store.onEscape(listener),
    onInterrupt: (listener) => store.onInterrupt(listener),
    noticeInterrupt: (text) => store.noticeInterrupt(text),
    waitForExit: () => instance.waitUntilExit(),
    unmount: () => {
      if (timer !== null) clearInterval(timer);
      instance.unmount();
    },
  };
}
