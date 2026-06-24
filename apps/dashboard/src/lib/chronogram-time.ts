import type { ChronogramDto, ChronogramLaneDto, ChronogramLaneState } from './contracts';

/**
 * AO6 Pillar 4 — pure time-travel helpers for the chronogram scrubber. The
 * orchestration is replayed from its lanes' start/complete timestamps: scrub a
 * time T and each lane's bar + state reflect its status AS OF T. No server round
 * trip — the {@link ChronogramDto} already carries the timeline.
 */

/** Parses an ISO timestamp to ms, or null. */
function ms(iso: string | null): number | null {
  if (iso === null) return null;
  const n = Date.parse(iso);
  return Number.isNaN(n) ? null : n;
}

/** A lane's effective END (ms): its completion, or `nowMs` while still running. */
function laneEndMs(lane: ChronogramLaneDto, nowMs: number): number | null {
  const s = ms(lane.startedAt);
  if (s === null) return null;
  const e = ms(lane.completedAt);
  if (e !== null) return e;
  return lane.state === 'running' ? nowMs : s;
}

/** The [t0, t1] span (ms) of the whole orchestration: earliest start → latest end. */
export function timeBounds(c: ChronogramDto, nowMs: number): { t0: number; t1: number } {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const lane of c.lanes) {
    const s = ms(lane.startedAt);
    if (s === null) continue;
    starts.push(s);
    const e = laneEndMs(lane, nowMs);
    if (e !== null) ends.push(e);
  }
  const t0 = starts.length > 0 ? Math.min(...starts) : nowMs;
  const t1 = ends.length > 0 ? Math.max(...ends) : t0 + 1;
  return { t0, t1: Math.max(t1, t0 + 1) };
}

/**
 * A lane's state AS OF time `t` (time-travel): `pending` before it started,
 * `running` from start until it completed, then its recorded final state
 * (done/empty/failed/cancelled). A still-running lane stays `running`.
 */
export function laneStateAt(lane: ChronogramLaneDto, t: number): ChronogramLaneState {
  const s = ms(lane.startedAt);
  if (s === null || t < s) return 'pending';
  const e = ms(lane.completedAt);
  if (e !== null && t >= e) return lane.state;
  return 'running';
}

/** The bar geometry [leftPct, widthPct] for a lane on a `[t0,t1]` axis, clipped to `t` (the scrub head). */
export function laneBarAt(
  lane: ChronogramLaneDto,
  t: number,
  t0: number,
  t1: number,
  nowMs: number,
): { hasBar: boolean; left: number; width: number } {
  const s = ms(lane.startedAt);
  const span = Math.max(1, t1 - t0);
  if (s === null || t < s) return { hasBar: false, left: 0, width: 0 };
  const end = Math.min(t, laneEndMs(lane, nowMs) ?? s);
  const left = ((s - t0) / span) * 100;
  const width = Math.max(2.5, ((Math.max(end, s) - s) / span) * 100);
  return { hasBar: true, left, width };
}
