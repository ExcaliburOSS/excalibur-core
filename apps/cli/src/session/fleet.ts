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

export type ThreadStatus = 'running' | 'blocked' | 'paused' | 'done' | 'failed';

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
  /** INT-5 — the task to re-dispatch when a PAUSED thread is resumed (interrupted
   * work is a first-class resumable thread). Set when the thread is paused. */
  resumeTask?: string;
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

/**
 * INT-5 — registers the work that was just INTERRUPTED as a PAUSED, resumable
 * thread (a pause+switch). Does NOT steal focus (the new work runs in the
 * foreground); `resumeTask` is what the REPL re-dispatches to resume it. If a
 * thread with `id` already exists it is flipped to paused; otherwise a new paused
 * entry is added. A blank task is a no-op (nothing meaningful to resume).
 */
export function pauseThread(
  state: FleetState,
  id: string,
  title: string,
  resumeTask: string,
): FleetState {
  if (resumeTask.trim().length === 0) {
    return state;
  }
  const existing = state.threads.findIndex((t) => t.id === id);
  if (existing !== -1) {
    return {
      ...state,
      threads: state.threads.map((t) => (t.id === id ? { ...t, status: 'paused', resumeTask } : t)),
      foreground: state.foreground === existing ? -1 : state.foreground,
    };
  }
  return {
    ...state,
    threads: [
      ...state.threads,
      { id, title, status: 'paused', draft: '', banner: null, resumeTask },
    ],
  };
}

/** INT-5 — the paused (interrupted) threads, in registration order, for the
 * resume offer + `/threads`. */
export function pausedThreads(state: FleetState): FleetThread[] {
  return state.threads.filter((t) => t.status === 'paused');
}

/** INT-5 — flips a paused thread back to running (the REPL then re-dispatches its
 * `resumeTask` and settles it). No-op for an unknown / non-paused id. */
export function resumeThread(state: FleetState, id: string): FleetState {
  const thread = state.threads.find((t) => t.id === id);
  if (thread === undefined || thread.status !== 'paused') {
    return state;
  }
  return {
    ...state,
    threads: state.threads.map((t) => (t.id === id ? { ...t, status: 'running' } : t)),
  };
}

/** INT-5 — drops a paused thread the user chose not to resume (dismiss). */
export function dropThread(state: FleetState, id: string): FleetState {
  const threads = state.threads.filter((t) => t.id !== id);
  if (threads.length === state.threads.length) {
    return state;
  }
  const droppedIndex = state.threads.findIndex((t) => t.id === id);
  return {
    threads,
    foreground:
      state.foreground === droppedIndex
        ? -1
        : state.foreground > droppedIndex
          ? state.foreground - 1
          : state.foreground,
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

/** Live = running or blocked. Counts for the status bar (`⚑` = blocked, `⏸` =
 * paused). `active` stays running+blocked (a paused thread holds no slot). */
export function fleetCounts(state: FleetState): {
  running: number;
  blocked: number;
  paused: number;
  done: number;
  failed: number;
  active: number;
} {
  let running = 0,
    blocked = 0,
    paused = 0,
    done = 0,
    failed = 0;
  for (const t of state.threads) {
    if (t.status === 'running') running += 1;
    else if (t.status === 'blocked') blocked += 1;
    else if (t.status === 'paused') paused += 1;
    else if (t.status === 'done') done += 1;
    else failed += 1;
  }
  return { running, blocked, paused, done, failed, active: running + blocked };
}

/** Removes settled (done/failed) threads — e.g. after their banners are shown.
 * Paused threads are NOT settled (they are resumable), so they survive. */
export function pruneSettled(state: FleetState): FleetState {
  const threads = state.threads.filter((t) => t.status !== 'done' && t.status !== 'failed');
  if (threads.length === state.threads.length) {
    return state;
  }
  return { threads, foreground: -1 };
}
