/**
 * The fleet of concurrent agent threads in the m-shell — the PURE state machine.
 *
 * The shell can run several agent turns at once (a foreground turn plus
 * background threads started with `/bg`). This module owns the thread registry
 * and the focus/surfacing rules ([[project-excalibur-approval-ux]]) with NO I/O,
 * so the behaviour is unit-testable without a TTY; the REPL wires real async
 * dispatch, rendering and key handling on top.
 *
 * Surfacing rules (urgency hierarchy):
 *  1. A thread that becomes BLOCKED (needs a response) auto-focuses — the
 *     foreground switches to it; the prior foreground's draft is preserved.
 *  2. A thread that finishes (done/failed) raises a one-shot BANNER above the
 *     prompt — it never steals focus.
 *  3. Voluntary navigation (Tab) cycles the foreground across live threads.
 */

export type ThreadStatus = 'running' | 'blocked' | 'done' | 'failed';

export interface FleetThread {
  id: string;
  title: string;
  status: ThreadStatus;
  /** A draft preserved when focus moved away from this thread. */
  draft: string;
  /** A pending one-shot banner (set on settle), drained by the REPL. */
  banner: string | null;
  /** AO8-1 — a task to auto-dispatch when this thread completes (reaction-on-
   * completion / chaining); absent = no follow-up. Consumed once by the REPL. */
  followUp?: string;
}

export interface FleetState {
  threads: FleetThread[];
  /** Index into `threads` of the foreground thread, or -1 = the main prompt. */
  foreground: number;
}

export function initialFleet(): FleetState {
  return { threads: [], foreground: -1 };
}

/** Registers a new running thread (does NOT steal focus). AO8-1: an optional
 * `followUp` task is stored to auto-dispatch when this thread completes. */
export function spawnThread(
  state: FleetState,
  id: string,
  title: string,
  followUp?: string,
): FleetState {
  if (state.threads.some((t) => t.id === id)) {
    return state;
  }
  return {
    ...state,
    threads: [
      ...state.threads,
      {
        id,
        title,
        status: 'running',
        draft: '',
        banner: null,
        ...(followUp !== undefined && followUp.length > 0 ? { followUp } : {}),
      },
    ],
  };
}

/** Marks a thread blocked (needs input) and AUTO-FOCUSES it (rule 1). */
export function blockThread(state: FleetState, id: string): FleetState {
  const index = state.threads.findIndex((t) => t.id === id);
  if (index === -1) {
    return state;
  }
  return {
    ...state,
    threads: state.threads.map((t) => (t.id === id ? { ...t, status: 'blocked' } : t)),
    foreground: index,
  };
}

/**
 * Settles a thread (done/failed) with a one-shot banner (rule 2 — never steals
 * focus). If the settled thread was the foreground, focus falls back to the main
 * prompt so the user is not left "inside" a finished thread.
 */
export function settleThread(
  state: FleetState,
  id: string,
  status: 'done' | 'failed',
  banner: string,
): FleetState {
  const index = state.threads.findIndex((t) => t.id === id);
  if (index === -1) {
    return state;
  }
  return {
    threads: state.threads.map((t) => (t.id === id ? { ...t, status, banner } : t)),
    foreground: state.foreground === index ? -1 : state.foreground,
  };
}

/** Tab — cycles the foreground across LIVE (running/blocked) threads + the main
 * prompt (-1), preserving the leaving thread's draft. */
export function cycleForeground(state: FleetState, currentDraft: string): FleetState {
  const live = state.threads
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.status === 'running' || t.status === 'blocked');
  if (live.length === 0) {
    return state; // nothing to cycle to
  }
  const stops = [-1, ...live.map(({ i }) => i)]; // main prompt + each live thread
  const pos = stops.indexOf(state.foreground);
  const next = stops[(pos + 1) % stops.length] ?? -1;
  // Preserve the draft of whatever we are leaving.
  const threads =
    state.foreground >= 0
      ? state.threads.map((t, i) => (i === state.foreground ? { ...t, draft: currentDraft } : t))
      : state.threads;
  return { threads, foreground: next };
}

/** Drains all pending banners (clearing them) so the REPL can print them once. */
export function drainBanners(state: FleetState): { state: FleetState; banners: string[] } {
  const banners = state.threads.filter((t) => t.banner !== null).map((t) => t.banner as string);
  if (banners.length === 0) {
    return { state, banners };
  }
  return {
    state: { ...state, threads: state.threads.map((t) => (t.banner ? { ...t, banner: null } : t)) },
    banners,
  };
}

/** Live = running or blocked. Counts for the status bar (`⚑` = blocked). */
export function fleetCounts(state: FleetState): {
  running: number;
  blocked: number;
  done: number;
  failed: number;
  active: number;
} {
  let running = 0,
    blocked = 0,
    done = 0,
    failed = 0;
  for (const t of state.threads) {
    if (t.status === 'running') running += 1;
    else if (t.status === 'blocked') blocked += 1;
    else if (t.status === 'done') done += 1;
    else failed += 1;
  }
  return { running, blocked, done, failed, active: running + blocked };
}

/** Removes settled (done/failed) threads — e.g. after their banners are shown. */
export function pruneSettled(state: FleetState): FleetState {
  const threads = state.threads.filter((t) => t.status === 'running' || t.status === 'blocked');
  if (threads.length === state.threads.length) {
    return state;
  }
  return { threads, foreground: -1 };
}
