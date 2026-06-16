/**
 * The LIVING RAIL data model (plan §"TUI superior") — pure types, no React, so
 * the reducer + its tests never pull in Ink. A run is reduced from the
 * `ExcaliburEvent` stream into a {@link RailModel}; the Ink `<PhaseTimeline>`
 * renders it. Because both live, scrubbed (Esc-Esc) and replayed views fold the
 * SAME stream through the SAME reducer, every view is byte-identical.
 */

export type PhaseState = 'pending' | 'running' | 'completed' | 'waiting' | 'failed';

export interface PhaseEvent {
  text: string;
  /** A trailing annotation rendered dim/coloured, e.g. "+24 −6" or "12 passing". */
  note?: string;
  tone?: 'muted' | 'accent' | 'success' | 'warn';
}

export interface Phase {
  id: string;
  name: string;
  state: PhaseState;
  /** One-line summary shown next to the phase name once it is active/done. */
  detail?: string;
  /** Streamed events, shown only while the phase is the active one. */
  events?: PhaseEvent[];
}

export interface ApprovalPrompt {
  question: string;
  options: string; // e.g. "[y/N/always]"
}

export interface RunStatus {
  elapsedMs: number;
  costCents: number;
  safety: string;
  push: boolean;
  model: string;
}

/** The reduced state of a run — everything the rail needs to render. */
export interface RailModel {
  runId: string;
  title: string;
  autonomyLabel: string;
  phases: Phase[];
  status: RunStatus;
  approval?: ApprovalPrompt;
  done: boolean;
  errored: boolean;
}
