import { z } from 'zod';
import type { ExcaliburEvent, ExcaliburEventType, RunRecord } from '@excalibur/shared';
import { appendLineEnsured, readTextIfExists } from '../internal/fs-utils';
import { RunManager } from '../runs/run-manager';
import { join } from 'node:path';
import { EXCALIBUR_DIR } from '../config/load-config';

/**
 * The Excalibur time-machine model (replay / inspect / explain / annotate).
 *
 * Every run persists a deterministic event log (`.excalibur/runs/<id>/events.jsonl`)
 * plus a `run.json` record. This module is a PURE, surface-agnostic reconstruction
 * of that log into a navigable timeline — the flagship differentiator that lets you
 * rewind a run like a video (something a flat chat transcript structurally cannot
 * do). The CLI scrubber, the Ink TUI and the web Workbench all reuse this model;
 * nothing here touches `console`, a TTY or any rendering surface.
 *
 * The reconstruction is best-effort and NEVER throws on a sparse or partial log:
 * a half-written run, a run missing model_call costs, or one with no patch events
 * all degrade gracefully to the best available view.
 */

const ANNOTATIONS_FILE = 'annotations.jsonl';

/** One annotation pinned to a step of a run (persisted append-only). */
export const annotationSchema = z.object({
  /** Zero-based index of the {@link ReplayStep} this note is pinned to. */
  stepIndex: z.number().int().nonnegative(),
  /** The human note. */
  note: z.string(),
  /** ISO-8601 timestamp the note was added (supplied by the caller). */
  at: z.string(),
});
export type Annotation = z.infer<typeof annotationSchema>;

/** Cumulative token totals across `model_call` events up to (and incl.) a step. */
export interface TokenTotals {
  input: number;
  output: number;
}

/**
 * One step of a replay: a single event enriched with the phase it belongs to, a
 * concise human one-liner, and the cumulative cost/tokens accrued across every
 * `model_call` at or before this step.
 */
export interface ReplayStep {
  /** Zero-based position in the timeline. */
  index: number;
  /** The raw canonical event. */
  event: ExcaliburEvent;
  /** Name of the phase this event belongs to (null when outside any phase). */
  phaseName: string | null;
  /** A concise, human one-liner describing the event (e.g. `wrote src/x.ts`). */
  summary: string;
  /**
   * Cumulative cost in cents across all `model_call` events up to and including
   * this step, or `null` when NONE of those calls carried a `costCents` value
   * (a sparse log must not invent a misleading $0.00).
   */
  costCentsSoFar: number | null;
  /** Cumulative input/output tokens across `model_call` events up to this step. */
  tokensSoFar: TokenTotals;
}

/** The full reconstructed model of a run: its record plus the step timeline. */
export interface ReplayModel {
  run: RunRecord;
  steps: ReplayStep[];
}

/** A phase boundary: the step index where a phase started and (optionally) completed. */
export interface PhaseBoundary {
  phaseId: string | null;
  phaseName: string | null;
  /** Step index of the `phase_started` event. */
  startIndex: number;
  /** Step index of the matching `phase_completed`, or null when never completed. */
  endIndex: number | null;
}

/** Kinds a semantic jump can target. */
export type JumpKind = 'edit' | 'test' | 'command' | 'failure' | 'approval' | 'phase';

/** The reconstructed state of a run AT a given cursor (see {@link reconstructStateAt}). */
export interface ReconstructedState {
  /** The step at the cursor. */
  step: ReplayStep;
  /** The active phase name at the cursor (null when outside any phase). */
  phaseName: string | null;
  /** A window of events surrounding the cursor (chronological). */
  recentEvents: ExcaliburEvent[];
  /**
   * Best-effort accumulated diff at the cursor: the latest `patch_generated` /
   * `patch_applied` diff payload at or before the cursor, augmented with any
   * `file_write` change content. Empty string when the log carries no diff data.
   */
  accumulatedDiff: string;
  /** Cumulative cost in cents at the cursor (null when no call carried a cost). */
  costCentsSoFar: number | null;
}

// --- summaries ---------------------------------------------------------------

/** Reads a string payload field, or null. */
function str(event: ExcaliburEvent, key: string): string | null {
  const value = event.payload[key];
  return typeof value === 'string' ? value : null;
}

/** Reads a number payload field, or null. */
function num(event: ExcaliburEvent, key: string): number | null {
  const value = event.payload[key];
  return typeof value === 'number' ? value : null;
}

/** First affected path from a `filesAffected: string[]` payload, or null. */
function firstAffected(event: ExcaliburEvent): string | null {
  const value = event.payload['filesAffected'];
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === 'string' && entry.length > 0);
    return typeof first === 'string' ? first : null;
  }
  return null;
}

/** Human-friendly token count (`1.2k`, `340`). */
function compactCount(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return String(value);
}

/** Builds the concise one-liner for an event. Surface-agnostic (no color). */
function summarize(event: ExcaliburEvent): string {
  switch (event.type) {
    case 'run_started':
      return `run started: ${str(event, 'title') ?? '(untitled)'}`;
    case 'run_completed':
      return `run ${str(event, 'status') ?? 'completed'}`;
    case 'workflow_selected':
      return `workflow ${str(event, 'name') ?? str(event, 'workflowId') ?? '(unknown)'} selected`;
    case 'methodology_selected':
      return `methodology ${str(event, 'methodologyId') ?? '(unknown)'} selected`;
    case 'phase_started':
      return `phase ${str(event, 'name') ?? '(unnamed)'} started`;
    case 'phase_completed':
      return `phase ${str(event, 'name') ?? '(unnamed)'} ${str(event, 'status') ?? 'completed'}`;
    case 'assistant_message': {
      const artifact = str(event, 'artifact');
      return artifact !== null ? `assistant message → ${artifact}` : 'assistant message';
    }
    case 'model_call': {
      const input = num(event, 'inputTokens');
      const output = num(event, 'outputTokens');
      if (input !== null && output !== null) {
        return `model call (${compactCount(input)} in / ${compactCount(output)} out)`;
      }
      return 'model call';
    }
    case 'tool_call':
      return `tool call: ${str(event, 'name') ?? str(event, 'tool') ?? '(unknown)'}`;
    case 'file_read':
      return `read ${str(event, 'path') ?? str(event, 'file') ?? '(file)'}`;
    case 'file_write':
      return `wrote ${str(event, 'path') ?? str(event, 'file') ?? '(file)'}`;
    case 'command_started':
      return `started "${str(event, 'command') ?? '(command)'}"`;
    case 'command_completed': {
      const command = str(event, 'command') ?? '(command)';
      const exitCode = num(event, 'exitCode');
      const outcome = exitCode === null ? 'done' : exitCode === 0 ? 'exit 0' : `exit ${exitCode}`;
      return `ran "${command}" → ${outcome}`;
    }
    case 'test_result': {
      const status = str(event, 'status') ?? 'unknown';
      return `tests ${status === 'passed' ? '→ passed' : status === 'failed' ? '→ failed' : `→ ${status}`}`;
    }
    case 'patch_generated': {
      const affected = firstAffected(event);
      return affected !== null ? `patch generated → ${affected}` : 'patch generated';
    }
    case 'patch_applied': {
      const affected = firstAffected(event);
      return affected !== null ? `patch applied → ${affected}` : 'patch applied';
    }
    case 'branch_created':
      return `branch created: ${str(event, 'branch') ?? str(event, 'name') ?? '(branch)'}`;
    case 'approval_requested':
      return `approval requested: ${str(event, 'question') ?? '(no detail)'}`;
    case 'approval_approved':
      return 'approval approved';
    case 'approval_rejected':
      return 'approval rejected';
    case 'policy_decision': {
      const message = str(event, 'message');
      const decision = str(event, 'decision') ?? 'decision';
      return message !== null ? `policy: ${message}` : `policy decision: ${decision}`;
    }
    case 'error':
      return `error: ${str(event, 'message') ?? '(unknown error)'}`;
    case 'artifact_created':
      return `artifact created: ${str(event, 'artifact') ?? '(artifact)'}`;
    default:
      return event.type;
  }
}

// --- model construction ------------------------------------------------------

/**
 * Resolves an event's phase NAME by tracking the most recent `phase_started`
 * while folding events into steps. Events carry a `phaseId` but the human name
 * lives only in the `phase_started`/`phase_completed` payload, so we thread the
 * active phase name through the fold.
 */
function buildSteps(events: ExcaliburEvent[]): ReplayStep[] {
  const steps: ReplayStep[] = [];
  // Map phaseId -> name, learned from phase_started/completed payloads.
  const phaseNames = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'phase_started' || event.type === 'phase_completed') {
      const name = str(event, 'name');
      if (event.phaseId != null && name !== null) {
        phaseNames.set(event.phaseId, name);
      }
    }
  }

  let costCents: number | null = null;
  let tokensInput = 0;
  let tokensOutput = 0;
  // The active phase at each event: the last phase_started not yet completed.
  let activePhaseName: string | null = null;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index] as ExcaliburEvent;

    if (event.type === 'phase_started') {
      activePhaseName = str(event, 'name') ?? (event.phaseId != null ? phaseNames.get(event.phaseId) ?? null : null);
    }

    if (event.type === 'model_call') {
      const cost = num(event, 'costCents');
      if (cost !== null) {
        costCents = (costCents ?? 0) + cost;
      }
      tokensInput += num(event, 'inputTokens') ?? 0;
      tokensOutput += num(event, 'outputTokens') ?? 0;
    }

    // The phase name attributed to THIS event: prefer the event's own phaseId
    // mapping, fall back to the active phase tracked across the timeline.
    const ownPhaseName =
      event.phaseId != null ? phaseNames.get(event.phaseId) ?? null : null;
    const phaseName = ownPhaseName ?? activePhaseName;

    steps.push({
      index,
      event,
      phaseName,
      summary: summarize(event),
      costCentsSoFar: costCents,
      tokensSoFar: { input: tokensInput, output: tokensOutput },
    });

    if (event.type === 'phase_completed') {
      activePhaseName = null;
    }
  }

  return steps;
}

/**
 * Loads the full replay model of a run: its `run.json` record plus the step
 * timeline reconstructed from `events.jsonl`. Uses {@link RunManager} so it
 * shares the exact same on-disk contract as the rest of Core. Throws
 * `RunNotFoundError` only when the run itself does not exist; a run with an
 * empty/missing event log yields a model with zero steps (never throws).
 */
export function loadReplay(repoRoot: string, runId: string): ReplayModel {
  const manager = new RunManager(repoRoot);
  const run = manager.getRun(runId);
  const events = manager.readEvents(runId);
  return { run: run.record, steps: buildSteps(events) };
}

// --- cursor reconstruction ---------------------------------------------------

/** Clamps a cursor to the valid `[0, steps.length - 1]` range (0 on empty). */
function clampCursor(model: ReplayModel, cursor: number): number {
  if (model.steps.length === 0) {
    return 0;
  }
  if (cursor < 0) {
    return 0;
  }
  if (cursor > model.steps.length - 1) {
    return model.steps.length - 1;
  }
  return cursor;
}

const RECENT_WINDOW = 5;

/**
 * Reconstructs the state of a run AT a cursor: the step there, the active phase,
 * a window of surrounding events, the best-effort accumulated diff up to that
 * point, and the cumulative cost. Never throws on a sparse log — an empty run
 * yields a synthetic empty state.
 *
 * The accumulated diff is best-effort: it takes the latest `patch_generated` /
 * `patch_applied` diff payload at or before the cursor (the most complete
 * unified diff the producer emitted), and falls back to concatenating
 * `file_write` change payloads when no patch diff is present. When the log
 * carries neither, the diff is an empty string (the caller renders a note).
 */
export function reconstructStateAt(model: ReplayModel, cursor: number): ReconstructedState {
  if (model.steps.length === 0) {
    return {
      step: {
        index: 0,
        event: {
          id: 'evt_empty',
          runId: model.run.id,
          type: 'run_started',
          timestamp: model.run.startedAt,
          phaseId: null,
          sessionId: null,
          payload: {},
        },
        phaseName: null,
        summary: '(no events recorded)',
        costCentsSoFar: null,
        tokensSoFar: { input: 0, output: 0 },
      },
      phaseName: null,
      recentEvents: [],
      accumulatedDiff: '',
      costCentsSoFar: null,
    };
  }

  const position = clampCursor(model, cursor);
  const step = model.steps[position] as ReplayStep;

  const from = Math.max(0, position - RECENT_WINDOW + 1);
  const recentEvents = model.steps.slice(from, position + 1).map((entry) => entry.event);

  return {
    step,
    phaseName: step.phaseName,
    recentEvents,
    accumulatedDiff: accumulatedDiffAt(model, position),
    costCentsSoFar: step.costCentsSoFar,
  };
}

/**
 * Best-effort accumulated diff at a step: the latest patch diff at or before the
 * cursor wins (it is the most complete unified diff a producer emits); when none
 * exists, concatenate any `file_write` change payloads instead. `''` when the
 * log carries no diff data at all.
 */
function accumulatedDiffAt(model: ReplayModel, position: number): string {
  let latestPatchDiff: string | null = null;
  const fileWrites: string[] = [];

  for (let index = 0; index <= position; index += 1) {
    const event = (model.steps[index] as ReplayStep).event;
    if (event.type === 'patch_generated' || event.type === 'patch_applied') {
      const diff = str(event, 'diff');
      if (diff !== null && diff.length > 0) {
        latestPatchDiff = diff;
      }
    } else if (event.type === 'file_write') {
      const change = str(event, 'diff') ?? str(event, 'content') ?? str(event, 'change');
      const path = str(event, 'path') ?? str(event, 'file');
      if (change !== null && change.length > 0) {
        fileWrites.push(path !== null ? `# ${path}\n${change}` : change);
      }
    }
  }

  if (latestPatchDiff !== null) {
    return latestPatchDiff;
  }
  return fileWrites.join('\n\n');
}

// --- semantic jumps ----------------------------------------------------------

/** Whether a `test_result`/`command_completed`/`error` event represents a failure. */
function isFailure(event: ExcaliburEvent): boolean {
  if (event.type === 'error') {
    return true;
  }
  if (event.type === 'test_result') {
    return str(event, 'status') === 'failed';
  }
  if (event.type === 'command_completed') {
    const exitCode = num(event, 'exitCode');
    return exitCode !== null && exitCode !== 0;
  }
  return false;
}

const KIND_TYPES: Record<Exclude<JumpKind, 'failure'>, ExcaliburEventType[]> = {
  edit: ['file_write', 'patch_generated', 'patch_applied'],
  test: ['test_result'],
  command: ['command_started', 'command_completed'],
  approval: ['approval_requested', 'approval_approved', 'approval_rejected'],
  phase: ['phase_started', 'phase_completed'],
};

/** Predicate matching a step against a {@link JumpKind}. */
function matchesKind(event: ExcaliburEvent, kind: JumpKind): boolean {
  if (kind === 'failure') {
    return isFailure(event);
  }
  return KIND_TYPES[kind].includes(event.type);
}

/**
 * Index of the next step of `kind` strictly AFTER `fromIndex`, or null when
 * there is none. `fromIndex < 0` searches from the very start (so the first
 * matching step is found). Surface-agnostic — the CLI/TUI use it for `e`/`t`/…
 */
export function nextStepOfKind(
  model: ReplayModel,
  fromIndex: number,
  kind: JumpKind,
): number | null {
  for (let index = Math.max(-1, fromIndex) + 1; index < model.steps.length; index += 1) {
    const event = (model.steps[index] as ReplayStep).event;
    if (matchesKind(event, kind)) {
      return index;
    }
  }
  return null;
}

/**
 * Index of the previous step of `kind` strictly BEFORE `fromIndex`, or null.
 * The mirror of {@link nextStepOfKind} for backward navigation.
 */
export function prevStepOfKind(
  model: ReplayModel,
  fromIndex: number,
  kind: JumpKind,
): number | null {
  for (let index = Math.min(model.steps.length, fromIndex) - 1; index >= 0; index -= 1) {
    const event = (model.steps[index] as ReplayStep).event;
    if (matchesKind(event, kind)) {
      return index;
    }
  }
  return null;
}

/** Every phase boundary in the run, in chronological order. */
export function phaseBoundaries(model: ReplayModel): PhaseBoundary[] {
  const boundaries: PhaseBoundary[] = [];
  const openByPhaseId = new Map<string, number>();

  for (let index = 0; index < model.steps.length; index += 1) {
    const event = (model.steps[index] as ReplayStep).event;
    if (event.type === 'phase_started') {
      const boundary: PhaseBoundary = {
        phaseId: event.phaseId ?? null,
        phaseName: str(event, 'name'),
        startIndex: index,
        endIndex: null,
      };
      boundaries.push(boundary);
      if (event.phaseId != null) {
        openByPhaseId.set(event.phaseId, boundaries.length - 1);
      }
    } else if (event.type === 'phase_completed' && event.phaseId != null) {
      const openIndex = openByPhaseId.get(event.phaseId);
      if (openIndex !== undefined) {
        (boundaries[openIndex] as PhaseBoundary).endIndex = index;
        openByPhaseId.delete(event.phaseId);
      }
    }
  }

  return boundaries;
}

// --- annotations -------------------------------------------------------------

function annotationsPath(repoRoot: string, runId: string): string {
  return join(repoRoot, EXCALIBUR_DIR, 'runs', runId, ANNOTATIONS_FILE);
}

/**
 * Loads the annotations pinned to a run, in append order. Tolerant: a malformed
 * line is skipped rather than throwing, so a partially-written annotations file
 * never breaks replay. Returns `[]` when the file does not exist.
 */
export function loadAnnotations(repoRoot: string, runId: string): Annotation[] {
  const content = readTextIfExists(annotationsPath(repoRoot, runId));
  if (content === null) {
    return [];
  }
  const annotations: Annotation[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed = annotationSchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) {
        annotations.push(parsed.data);
      }
    } catch {
      // Tolerant: skip a corrupted line, keep the rest.
    }
  }
  return annotations;
}

/** Input to {@link addAnnotation}. `at` is supplied by the caller (no Date.now in core). */
export interface AddAnnotationInput {
  stepIndex: number;
  note: string;
  /** ISO-8601 timestamp the annotation was created. */
  at: string;
}

/**
 * Appends an annotation to a run's `annotations.jsonl` (append-only, never
 * rewrites history). Returns the persisted {@link Annotation}.
 */
export function addAnnotation(
  repoRoot: string,
  runId: string,
  input: AddAnnotationInput,
): Annotation {
  const annotation: Annotation = annotationSchema.parse({
    stepIndex: input.stepIndex,
    note: input.note,
    at: input.at,
  });
  appendLineEnsured(annotationsPath(repoRoot, runId), JSON.stringify(annotation));
  return annotation;
}

/** Annotations pinned to a specific step (convenience for inline rendering). */
export function annotationsForStep(annotations: Annotation[], stepIndex: number): Annotation[] {
  return annotations.filter((annotation) => annotation.stepIndex === stepIndex);
}
