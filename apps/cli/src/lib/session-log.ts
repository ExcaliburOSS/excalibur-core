import { buildTurnSummary, loadReplay } from '@excalibur/core';
import type { SessionTurn } from '@excalibur/core';
import type { RunStatus } from '@excalibur/shared';
import type { Translator } from '@excalibur/shared';

/**
 * The Session Log — the time-machine at the SESSION level (distinct from
 * `/rewind`, which is per-run). A session spawns 0..N runs; each assistant turn
 * records its run id in `artifactRef`. This module aggregates those runs into a
 * navigable index: the front-door to the per-run scrubber that does NOT require
 * knowing a run id (`/rewind <id>` already does, when you do). Plan §"Session
 * Log". Pure data + reuse of `loadReplay`/`buildTurnSummary`/`runScrubber` —
 * no new machinery.
 */

/** One run in the session, summarised for the index line. */
export interface SessionLogEntry {
  /** 1-based position in the session (display order = chronological). */
  position: number;
  runId: string;
  title: string;
  status: RunStatus;
  model: string | null;
  costCents: number | null;
  /** Changed-file counts (0 for a read-only run). */
  files: number;
  insertions: number;
  deletions: number;
  startedAt: string;
  completedAt: string | null;
}

/**
 * Builds the session's run index from its transcript: the distinct run ids in
 * first-appearance order, each resolved via the replay model. Runs whose
 * artifacts are missing/corrupt are skipped (best-effort — the log never
 * throws on a half-written run). `read` defaults to the real loaders but is
 * injectable for tests.
 */
export function buildSessionLog(
  repoRoot: string,
  transcript: SessionTurn[],
  read: {
    loadReplay: typeof loadReplay;
    buildTurnSummary: typeof buildTurnSummary;
  } = { loadReplay, buildTurnSummary },
): SessionLogEntry[] {
  const seen = new Set<string>();
  const runIds: string[] = [];
  for (const turn of transcript) {
    const runId = turn.artifactRef;
    if (runId === undefined || seen.has(runId)) {
      continue;
    }
    seen.add(runId);
    runIds.push(runId);
  }

  const entries: SessionLogEntry[] = [];
  for (const runId of runIds) {
    let model;
    try {
      model = read.loadReplay(repoRoot, runId);
    } catch {
      continue; // missing/corrupt run — skip it, never break the log
    }
    if (model.steps.length === 0 && model.run.title.length === 0) {
      continue;
    }
    const summary = read.buildTurnSummary(model);
    entries.push({
      position: entries.length + 1,
      runId,
      title: model.run.title,
      status: model.run.status,
      model: model.run.model,
      costCents: summary.metrics.costCents,
      files: summary.metrics.files,
      insertions: summary.metrics.insertions,
      deletions: summary.metrics.deletions,
      startedAt: model.run.startedAt,
      completedAt: model.run.completedAt,
    });
  }
  return entries;
}

/** Run-status glyph for the index (mono, no colour — colour is applied by the caller). */
export function statusGlyph(status: RunStatus): string {
  switch (status) {
    case 'completed':
      return '✓';
    case 'failed':
      return '✗';
    case 'cancelled':
      return '⊘';
    case 'waiting_approval':
      return '⚑';
    case 'running':
      return '◐';
    case 'queued':
      return '○';
  }
}

/** `$0.04`, or `—` when no model call carried a cost. */
function formatCost(costCents: number | null): string {
  return costCents === null ? '—' : `$${(costCents / 100).toFixed(2)}`;
}

/** `✎2 +5 −1`, or `—` for a read-only run. Mirrors the receipt's diffstat. */
function formatDiffstat(entry: SessionLogEntry): string {
  if (entry.files === 0) {
    return '—';
  }
  return `✎${entry.files} +${entry.insertions} −${entry.deletions}`;
}

/** Relative "just now / 2s ago / 14:32" using the shared receipt keys. */
function formatWhen(t: Translator, now: Date, startedAt: string): string {
  const at = new Date(startedAt);
  if (Number.isNaN(at.getTime())) {
    return '';
  }
  const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const deltaSec = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));
  const rel =
    deltaSec < 2
      ? t('turn-receipt.just-now')
      : deltaSec < 60
        ? t('turn-receipt.seconds-ago', { seconds: deltaSec })
        : deltaSec < 3600
          ? t('turn-receipt.minutes-ago', { minutes: Math.floor(deltaSec / 60) })
          : t('turn-receipt.hours-ago', { hours: Math.floor(deltaSec / 3600) });
  return `${rel} · ${clock}`;
}

/**
 * Formats the session-log index into plain lines (no colour — testable; the
 * caller paints the glyph). The first line is the header, then one line per
 * run, then a footer hint. `now` is injected for deterministic relative times.
 */
export function formatSessionLog(
  entries: SessionLogEntry[],
  t: Translator,
  now: Date = new Date(),
): string[] {
  if (entries.length === 0) {
    return [t('session-log.empty')];
  }
  const totalCents = entries.reduce(
    (sum, entry) => (entry.costCents === null ? sum : sum + entry.costCents),
    0,
  );
  const lines: string[] = [
    t('session-log.heading', { runs: entries.length, cost: formatCost(totalCents) }),
    '',
  ];
  const width = String(entries.length).length;
  for (const entry of entries) {
    const num = String(entry.position).padStart(width);
    const title = entry.title.length > 0 ? entry.title : t('session-log.untitled');
    const model = entry.model ?? '—';
    const meta = `${model} · ${formatCost(entry.costCents)} · ${formatDiffstat(entry)} · ${formatWhen(t, now, entry.startedAt)}`;
    lines.push(`  ${num}. ${statusGlyph(entry.status)}  ${title}`);
    lines.push(`     ${meta}`);
  }
  lines.push('');
  lines.push(t('session-log.footer'));
  return lines;
}
