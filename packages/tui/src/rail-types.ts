/**
 * The LIVING RAIL data model (plan §"TUI superior") — pure types, no React, so
 * the reducer + its tests never pull in Ink. A run is reduced from the
 * `ExcaliburEvent` stream into a {@link RailModel}; the Ink `<PhaseTimeline>`
 * renders it. Because both live, scrubbed (Esc-Esc) and replayed views fold the
 * SAME stream through the SAME reducer, every view is byte-identical.
 */

export type PhaseState = 'pending' | 'running' | 'completed' | 'waiting' | 'failed';

/**
 * The semantic kind of a within-phase event. The reducer sets it; the renderer
 * maps it to a per-tool glyph (▭ read · ✎ write · ❯ command · ↳ result · ◈ tool
 * · …). Keeping it semantic (not a glyph string) means the reducer stays
 * presentation-free and the text + Ink renderers pick their own glyphs.
 */
export type PhaseEventKind =
  | 'tool'
  | 'read'
  | 'write'
  | 'command'
  | 'exit'
  | 'test'
  | 'patch'
  | 'branch'
  | 'compaction'
  | 'verification'
  | 'claim'
  | 'error';

export interface PhaseEvent {
  text: string;
  /** A trailing annotation rendered dim/coloured, e.g. "+24 −6" or "12 passing". */
  note?: string;
  tone?: 'muted' | 'accent' | 'success' | 'warn';
  /** Semantic kind, used by the renderer to pick a per-tool glyph. */
  kind?: PhaseEventKind;
}

export interface Phase {
  id: string;
  name: string;
  state: PhaseState;
  /** One-line summary shown next to the phase name once it is active/done. */
  detail?: string;
  /** Streamed events, shown only while the phase is the active one. */
  events?: PhaseEvent[];
  /** Wall-clock duration of the phase (set once it completes/fails). */
  durationMs?: number;
  /** Model cost attributed to this phase (sum of its `model_call`s). */
  costCents?: number;
}

export interface ApprovalPrompt {
  question: string;
  options: string; // e.g. "[y/N/always]"
}

/** One item of the agent's in-session checklist (the `task_update` event). */
export interface TodoItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface RunStatus {
  elapsedMs: number;
  costCents: number;
  safety: string;
  push: boolean;
  model: string;
  /** Total input tokens across the run's model calls. */
  inputTokens: number;
  /** Total output tokens across the run's model calls. */
  outputTokens: number;
}

/** The reduced state of a run — everything the rail needs to render. */
export interface RailModel {
  runId: string;
  title: string;
  autonomyLabel: string;
  phases: Phase[];
  status: RunStatus;
  approval?: ApprovalPrompt;
  /** The agent's live checklist (latest `task_update` snapshot), if any. */
  todos?: TodoItem[];
  done: boolean;
  errored: boolean;
}
