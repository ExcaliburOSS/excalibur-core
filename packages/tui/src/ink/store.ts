import type { ExcaliburEvent } from '@excalibur/shared';
import type { ApprovalPrompt } from '../rail-types.js';
import type { MissionRibbonModel } from '../mission-ribbon.js';

/**
 * The external store behind `mountRunView`: an event log + spinner frame +
 * interactive flags, exposed to React via `useSyncExternalStore`. The component
 * folds the events through the SAME `reduceRail` as the non-TTY presenter, so
 * the live and replayed models are identical. Kept framework-free (no React) so
 * the bridge stays testable on its own.
 */

export type ApprovalAnswer = 'yes' | 'no' | 'auto';

export interface RunViewSnapshot {
  /** The accumulated event log. MUTABLE (appended in place) — re-fold off
   * `eventsRev`, never off this array's identity. */
  events: ExcaliburEvent[];
  /** Bumped on each appended event — the re-fold key (so push stays O(1), not a
   * full-array copy per event → O(n²) over a run). */
  eventsRev: number;
  /** Spinner/clock tick — bumped to re-render the breathing indicator + elapsed. */
  frame: number;
  diffsExpanded: boolean;
  /** The pending interactive approval, or null. */
  approval: ApprovalPrompt | null;
  /**
   * The agent's prose for the CURRENT turn as it streams in, typed out live
   * before the turn's `model_call` event lands. Empty when no turn is streaming.
   * Live-only (never persisted) — it is replaced by the folded `narration` line
   * the moment the `model_call` event arrives, so it is cleared on that push.
   */
  streamingNarration: string;
  /**
   * The meta-orchestrator's plan ribbon (M8 #43), rendered ABOVE the run rail when
   * set — so the capability DAG stays pinned while the active capability's rail
   * runs below it. Null for an ordinary run/turn.
   */
  missionRibbon: MissionRibbonModel | null;
}

export interface RunViewStore {
  getSnapshot(): RunViewSnapshot;
  subscribe(listener: () => void): () => void;
  push(event: ExcaliburEvent): void;
  tick(): void;
  /** Set the live, still-streaming narration buffer for the current turn. */
  streamNarration(text: string): void;
  /** Set/refresh the mission plan ribbon shown above the rail. */
  setRibbon(model: MissionRibbonModel): void;
  /** Clear the rail event log (a new capability starts its own rail below the ribbon). */
  resetEvents(): void;
  toggleDiffs(): void;
  /** Show an approval and resolve once the user answers (y/n/a). */
  requestApproval(approval: ApprovalPrompt): Promise<ApprovalAnswer>;
  resolveApproval(answer: ApprovalAnswer): void;
  /** Register an ESC handler (the turn's AbortController). */
  onEscape(listener: () => void): () => void;
  fireEscape(): void;
}

/** The Ink `Key` flags this view cares about (a subset, for testability). */
export interface KeyFlags {
  escape?: boolean;
  return?: boolean;
  ctrl?: boolean;
}

/**
 * Maps ONE keystroke onto the store — the single source of the live-view key
 * bindings (single keys only, per the project rule): ESC or Ctrl-C aborts (when
 * Ink owns stdin these are the only ways to interrupt); while an approval is
 * pending y/Return → yes, a → auto, n → no; otherwise Space toggles the inline
 * diff. Pure (no Ink) so it is unit-testable on its own; `<Keys>` just forwards
 * Ink's `useInput` to it.
 */
export function applyRunViewKey(store: RunViewStore, input: string, key: KeyFlags): void {
  if (key.escape === true || (key.ctrl === true && input.toLowerCase() === 'c')) {
    store.fireEscape();
    return;
  }
  const { approval } = store.getSnapshot();
  if (approval !== null) {
    const ch = input.toLowerCase();
    if (key.return === true || ch === 'y') store.resolveApproval('yes');
    else if (ch === 'a') store.resolveApproval('auto');
    else if (ch === 'n') store.resolveApproval('no');
    return;
  }
  if (input === ' ') {
    store.toggleDiffs();
  }
}

export function createRunViewStore(initialEvents: ExcaliburEvent[] = []): RunViewStore {
  // The event log is a single mutable array; `push` appends in place (O(1)) and
  // bumps `eventsRev`, so a long run is O(n) not O(n²). Each `set` still yields a
  // fresh snapshot object (with the same `events` ref) so useSyncExternalStore
  // detects the change; the component re-folds reduceRail keyed on `eventsRev`.
  const events = initialEvents.slice();
  let snapshot: RunViewSnapshot = {
    events,
    eventsRev: 0,
    frame: 0,
    diffsExpanded: false,
    approval: null,
    streamingNarration: '',
    missionRibbon: null,
  };
  const listeners = new Set<() => void>();
  const escapeListeners = new Set<() => void>();
  let resolver: ((answer: ApprovalAnswer) => void) | null = null;

  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  // A fresh snapshot object on every change so useSyncExternalStore detects it.
  const set = (patch: Partial<RunViewSnapshot>): void => {
    snapshot = { ...snapshot, ...patch };
    emit();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    push(event) {
      events.push(event); // O(1) append in place
      // The model_call event carries the full turn prose, which the fold renders
      // as a committed `narration` line — so retire the live streaming buffer the
      // instant it lands (otherwise the same prose would show twice).
      const patch: Partial<RunViewSnapshot> = { eventsRev: snapshot.eventsRev + 1 };
      if (event.type === 'model_call' && snapshot.streamingNarration.length > 0) {
        patch.streamingNarration = '';
      }
      set(patch);
    },
    tick() {
      set({ frame: snapshot.frame + 1 });
    },
    streamNarration(text) {
      set({ streamingNarration: text });
    },
    setRibbon(model) {
      set({ missionRibbon: model });
    },
    resetEvents() {
      events.length = 0; // a new capability starts its rail fresh below the ribbon
      set({ eventsRev: snapshot.eventsRev + 1, streamingNarration: '' });
    },
    toggleDiffs() {
      set({ diffsExpanded: !snapshot.diffsExpanded });
    },
    requestApproval(approval) {
      return new Promise<ApprovalAnswer>((resolve) => {
        // If a prior approval is still pending (queued confirmations arriving
        // back-to-back), settle it safely as 'no' so its awaiter never hangs —
        // Ink owns stdin, so a dropped resolver would wedge the turn.
        if (resolver !== null) {
          const previous = resolver;
          resolver = null;
          previous('no');
        }
        resolver = resolve;
        set({ approval });
      });
    },
    resolveApproval(answer) {
      const resolve = resolver;
      resolver = null;
      set({ approval: null });
      resolve?.(answer);
    },
    onEscape(listener) {
      escapeListeners.add(listener);
      return () => {
        escapeListeners.delete(listener);
      };
    },
    fireEscape() {
      for (const listener of escapeListeners) listener();
    },
  };
}
