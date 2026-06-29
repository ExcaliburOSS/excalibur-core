import { stripReasoning, type ExcaliburEvent } from '@excalibur/shared';
import type { ApprovalPrompt } from '../rail-types.js';
import type { MissionRibbonModel } from '../mission-ribbon.js';
import type { PlanRibbonModel } from '../plan-ribbon.js';

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
  /**
   * The live PLAN ribbon (PLAN4): the structured plan rendered ABOVE the run rail
   * as a phase→step tree while it executes step by step (PLAN3). Null for an
   * ordinary run/turn (and for a mission, which uses {@link missionRibbon}).
   */
  planRibbon: PlanRibbonModel | null;
  /**
   * The interrupt channel (INT-1): the message the user is typing WHILE the run
   * streams, shown as a composing line at the foot of the rail. Empty when not
   * composing. Submitted (Enter) it is handed to the interrupt handler — which
   * triages it (steer/quick/new/stop/answer) without losing the running work —
   * then cleared. ESC still cancels the run; this never steals that.
   */
  interruptDraft: string;
  /**
   * Whether the interrupt channel is live — true only once a handler is wired
   * (the interactive turn loop). When false, keystrokes are NOT captured into a
   * draft (a plain run with nowhere to deliver an interrupt keeps the old Space =
   * toggle-diffs binding), so we never swallow input that would go nowhere.
   */
  interruptEnabled: boolean;
  /**
   * The instant acknowledgment after an interrupt is submitted — "▶ Running that
   * in parallel…", "⏸ Pausing X and switching…". Transient (never recorded into
   * the event stream, so it can't perturb the live==replay invariant); cleared
   * when the rail resets or the channel disarms. Empty when there is none.
   */
  interruptNotice: string;
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
  /** Set/refresh the live plan ribbon (PLAN4) shown above the rail. */
  setPlanRibbon(model: PlanRibbonModel): void;
  /** Clear the rail event log (a new capability starts its own rail below the ribbon). */
  resetEvents(): void;
  toggleDiffs(): void;
  /** Show an approval and resolve once the user answers (y/n/a). */
  requestApproval(approval: ApprovalPrompt): Promise<ApprovalAnswer>;
  resolveApproval(answer: ApprovalAnswer): void;
  /** Register an ESC handler (the turn's AbortController). */
  onEscape(listener: () => void): () => void;
  fireEscape(): void;
  /** Append typed text to the interrupt draft (INT-1). */
  appendInterrupt(text: string): void;
  /** Delete the last character of the interrupt draft. */
  backspaceInterrupt(): void;
  /** Discard the in-progress interrupt draft without submitting. */
  clearInterrupt(): void;
  /** Submit the trimmed draft to the interrupt handler and clear it (no-op if blank). */
  submitInterrupt(): void;
  /** Show the instant acknowledgment line after an interrupt is routed (transient). */
  noticeInterrupt(text: string): void;
  /**
   * Register the interrupt handler — the turn loop's triage+route. Registering
   * arms the channel (`interruptEnabled`); the last unsubscribe disarms it.
   */
  onInterrupt(listener: (text: string) => void): () => void;
}

/** The Ink `Key` flags this view cares about (a subset, for testability). */
export interface KeyFlags {
  escape?: boolean;
  return?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

/**
 * Maps ONE keystroke onto the store — the single source of the live-view key
 * bindings (single keys only, per the project rule):
 * - ESC / Ctrl-C always aborts (when Ink owns stdin these are the only ways to
 *   interrupt the run); this is never overridden by the typing channel.
 * - While an approval is pending: y/Return → yes, a → auto, n → no.
 * - Otherwise, when the interrupt channel is armed (INT-1): printable keys build
 *   a draft message, Backspace edits, Enter submits it to the interrupt handler
 *   (which triages it WITHOUT losing the running work). Space toggles the inline
 *   diff only when the draft is empty — once you are composing, Space is a space.
 * - When the channel is NOT armed (a plain run with no interrupt handler), Space
 *   keeps its legacy diff-toggle binding and other keys are inert.
 *
 * Pure (no Ink) so it is unit-testable on its own; `<Keys>` just forwards Ink's
 * `useInput` to it.
 */
export function applyRunViewKey(store: RunViewStore, input: string, key: KeyFlags): void {
  if (key.escape === true || (key.ctrl === true && input.toLowerCase() === 'c')) {
    store.fireEscape();
    return;
  }
  const snapshot = store.getSnapshot();
  if (snapshot.approval !== null) {
    const ch = input.toLowerCase();
    if (key.return === true || ch === 'y') store.resolveApproval('yes');
    else if (ch === 'a') store.resolveApproval('auto');
    else if (ch === 'n') store.resolveApproval('no');
    return;
  }
  if (snapshot.interruptEnabled !== true) {
    // No interrupt handler wired → keep the legacy Space = toggle-diffs binding.
    if (input === ' ') store.toggleDiffs();
    return;
  }
  // --- Interrupt typing channel ---
  if (key.return === true) {
    store.submitInterrupt();
    return;
  }
  if (key.backspace === true || key.delete === true) {
    store.backspaceInterrupt();
    return;
  }
  if (input === ' ') {
    // Space is the diff toggle when idle, a typed space once composing.
    if (snapshot.interruptDraft.length === 0) store.toggleDiffs();
    else store.appendInterrupt(' ');
    return;
  }
  // Printable text (supports paste of multiple chars); skip modifier combos and
  // control sequences (arrows/fn come through as empty input + key flags).
  if (key.ctrl !== true && key.meta !== true && input.length > 0 && !isControl(input)) {
    store.appendInterrupt(input);
  }
}

/** True when the string contains any C0 control character (so it is not typed text). */
function isControl(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
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
    planRibbon: null,
    interruptDraft: '',
    interruptEnabled: false,
    interruptNotice: '',
  };
  const listeners = new Set<() => void>();
  const escapeListeners = new Set<() => void>();
  const interruptListeners = new Set<(text: string) => void>();
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
      set({ streamingNarration: stripReasoning(text) });
    },
    setRibbon(model) {
      set({ missionRibbon: model });
    },
    setPlanRibbon(model) {
      set({ planRibbon: model });
    },
    resetEvents() {
      events.length = 0; // a new capability starts its rail fresh below the ribbon
      set({ eventsRev: snapshot.eventsRev + 1, streamingNarration: '', interruptNotice: '' });
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
    appendInterrupt(text) {
      set({ interruptDraft: snapshot.interruptDraft + text });
    },
    backspaceInterrupt() {
      if (snapshot.interruptDraft.length === 0) return;
      set({ interruptDraft: snapshot.interruptDraft.slice(0, -1) });
    },
    clearInterrupt() {
      if (snapshot.interruptDraft.length === 0) return;
      set({ interruptDraft: '' });
    },
    submitInterrupt() {
      const text = snapshot.interruptDraft.trim();
      if (text.length === 0) return;
      set({ interruptDraft: '' });
      for (const listener of interruptListeners) listener(text);
    },
    noticeInterrupt(text) {
      set({ interruptNotice: text });
    },
    onInterrupt(listener) {
      interruptListeners.add(listener);
      if (snapshot.interruptEnabled !== true) set({ interruptEnabled: true });
      return () => {
        interruptListeners.delete(listener);
        if (interruptListeners.size === 0 && snapshot.interruptEnabled === true) {
          set({ interruptEnabled: false, interruptDraft: '', interruptNotice: '' });
        }
      };
    },
  };
}
