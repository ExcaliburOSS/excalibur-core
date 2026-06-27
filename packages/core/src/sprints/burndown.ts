/**
 * PLAN5 — the BURNDOWN: remaining work (story points) per day across a sprint
 * window, against the ideal linear line. Pure + decoupled from the work-items
 * package: the caller projects its work-items into {@link BurndownItem}s (points =
 * estimate, or 1 per item when unestimated; doneDate = the day it reached `done`,
 * approximated from `updatedAt` since the local store keeps no completion history).
 */

export interface BurndownItem {
  /** Story points this item carries (callers fall back to 1 when unestimated). */
  points: number;
  /** `YYYY-MM-DD` the item was completed, or null if it isn't done. */
  doneDate: string | null;
}

export interface BurndownPoint {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Ideal remaining points (linear from total → 0 across the window). */
  ideal: number;
  /** Actual remaining points (total − points completed on/before this day). */
  remaining: number;
}

export interface Burndown {
  totalPoints: number;
  donePoints: number;
  /** How many items count toward the sprint. */
  itemCount: number;
  /** One entry per day in the inclusive window (zero-filled). */
  days: BurndownPoint[];
}

/** Each `YYYY-MM-DD` from `start` to `end` inclusive (empty if start > end). */
export function enumerateDays(start: string, end: string): string[] {
  const days: string[] = [];
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs > endMs) {
    return days;
  }
  const DAY = 86_400_000;
  for (let ms = startMs; ms <= endMs; ms += DAY) {
    days.push(new Date(ms).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Computes the burndown for the inclusive `[startDate, endDate]` window over the
 * given items. The ideal line falls linearly from the total to 0 on the last day;
 * the actual line is the total minus the points completed on or before each day.
 */
export function computeBurndown(
  startDate: string,
  endDate: string,
  items: BurndownItem[],
): Burndown {
  const totalPoints = items.reduce((sum, i) => sum + i.points, 0);
  const donePoints = items.reduce((sum, i) => sum + (i.doneDate !== null ? i.points : 0), 0);
  const dates = enumerateDays(startDate, endDate);

  const days: BurndownPoint[] = dates.map((date, index) => {
    // Ideal: total on day 0 → 0 on the final day (flat at total for a 1-day sprint).
    const ideal = dates.length <= 1 ? 0 : totalPoints * (1 - index / (dates.length - 1));
    const completedByDay = items.reduce(
      (sum, i) => sum + (i.doneDate !== null && i.doneDate <= date ? i.points : 0),
      0,
    );
    return {
      date,
      ideal: Math.round(ideal * 100) / 100,
      remaining: totalPoints - completedByDay,
    };
  });

  return { totalPoints, donePoints, itemCount: items.length, days };
}
