import type { PhaseEvent } from './rail-types.js';

/**
 * How many of an active phase's most-recent events stay visible in the live rail.
 *
 * As a long task accumulates actions, rendering ALL of them grows the live region
 * past the terminal viewport — which scrolls the phase header (the one breathing
 * "Working…" line, the only animated element) off the top. Capping the active
 * phase to a small tail keeps the header on screen and the rail a glanceable
 * "what's happening right now"; everything older collapses behind a single
 * "⋯ N earlier" indicator (still in the durable event log / `logs` replay).
 */
export const ACTIVE_EVENT_WINDOW = 5;

export interface WindowedEvents {
  /** Events dropped off the top (0 when nothing was collapsed). */
  hidden: number;
  /** The visible tail — at most `window` events, ending with the most recent. */
  events: PhaseEvent[];
  /** Index, in the ORIGINAL array, of the first visible event (for stable keys). */
  offset: number;
}

/**
 * Windows an active phase's event stream down to its most-recent tail. Returns the
 * full list unchanged when it already fits. Pure — shared by the Ink and the
 * string presenters so the live TTY view and the non-TTY/replay fallback collapse
 * identically (the two-presenters-of-one-model discipline).
 */
export function windowActiveEvents(
  events: readonly PhaseEvent[],
  window: number = ACTIVE_EVENT_WINDOW,
): WindowedEvents {
  const size = Math.max(1, Math.floor(window));
  if (events.length <= size) {
    return { hidden: 0, events: [...events], offset: 0 };
  }
  const offset = events.length - size;
  return { hidden: offset, events: events.slice(offset), offset };
}

/** Default template for the collapse indicator (English; the CLI injects i18n). */
export const EARLIER_INDICATOR = '⋯ {count} earlier';

/** Formats the "N earlier" collapse indicator, substituting the count into a template. */
export function formatEarlier(hidden: number, template: string = EARLIER_INDICATOR): string {
  return template.replace('{count}', String(hidden));
}
