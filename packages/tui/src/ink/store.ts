import type { ExcaliburEvent } from '@excalibur/shared';
import type { ApprovalPrompt } from '../rail-types.js';

/**
 * The external store behind `mountRunView`: an event log + spinner frame +
 * interactive flags, exposed to React via `useSyncExternalStore`. The component
 * folds the events through the SAME `reduceRail` as the non-TTY presenter, so
 * the live and replayed models are identical. Kept framework-free (no React) so
 * the bridge stays testable on its own.
 */

export type ApprovalAnswer = 'yes' | 'no' | 'auto';

export interface RunViewSnapshot {
  events: ExcaliburEvent[];
  /** Spinner/clock tick — bumped to re-render the breathing indicator + elapsed. */
  frame: number;
  diffsExpanded: boolean;
  /** The pending interactive approval, or null. */
  approval: ApprovalPrompt | null;
}

export interface RunViewStore {
  getSnapshot(): RunViewSnapshot;
  subscribe(listener: () => void): () => void;
  push(event: ExcaliburEvent): void;
  tick(): void;
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
  let snapshot: RunViewSnapshot = {
    events: initialEvents.slice(),
    frame: 0,
    diffsExpanded: false,
    approval: null,
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
      set({ events: [...snapshot.events, event] });
    },
    tick() {
      set({ frame: snapshot.frame + 1 });
    },
    toggleDiffs() {
      set({ diffsExpanded: !snapshot.diffsExpanded });
    },
    requestApproval(approval) {
      return new Promise<ApprovalAnswer>((resolve) => {
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
