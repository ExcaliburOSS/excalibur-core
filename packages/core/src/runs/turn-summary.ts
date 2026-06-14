import type { ExcaliburEvent } from '@excalibur/shared';
import { reconstructStateAt, type ReplayModel } from '../replay/replay';

/**
 * The post-turn receipt model (M-Shell DX).
 *
 * A turn of agentic work is summarized in TWO layers:
 *  1. a DETERMINISTIC receipt derived here from the run's event stream — files
 *     changed (+/− diffstat), commands/tests and their outcome, cost/tokens,
 *     declined approvals. Because it is computed from `events.jsonl` (what
 *     actually happened) rather than the model's self-report, it can neither
 *     hallucinate a change nor silently omit one — the edge a flat chat
 *     transcript (Claude Code / OpenCode) structurally cannot have;
 *  2. a SHORT model narrative — the loop's final assistant message (the model's
 *     own concise summary), carried in {@link TurnSummary.narrative}.
 *
 * This module is PURE and surface-agnostic (no color, no TTY, no `Date.now`):
 * the CLI light renderer, the Ink TUI and the web Workbench all reuse it, and it
 * serializes to `summary.md` so the time-machine and Enterprise sync get it for
 * free. The renderer owns ALL user-facing strings (localizable later); the model
 * returns structured data + a discriminated {@link NextHint}.
 */

/** Coarse class of a turn — drives how much receipt the renderer shows. */
export type TurnTier = 'answer' | 'action' | 'failed' | 'partial';

/** One file the turn touched, with its diffstat. */
export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  insertions: number;
  deletions: number;
}

/** One command/test the turn ran and how it ended. */
export interface TurnCheck {
  /** The command line (`npm test`) or `tests` for a test_result. */
  label: string;
  ok: boolean;
  /** A short outcome detail (`142 passed`, `exit 1`), or null. */
  detail: string | null;
}

/** Aggregate counters for the turn. */
export interface TurnMetrics {
  files: number;
  insertions: number;
  deletions: number;
  inputTokens: number;
  outputTokens: number;
  /** Cumulative cost in cents, or null when no model call carried a cost. */
  costCents: number | null;
}

/**
 * The single most useful next action, as STRUCTURED data (the renderer maps it
 * to a localized one-liner). Null when the turn needs no follow-up.
 */
export type NextHint =
  | { kind: 'apply'; runId: string }
  | { kind: 'fix_failures' }
  | { kind: 'branch'; branch: string }
  | { kind: 'resolve_block' };

/** The full reconstructed receipt for one turn. */
export interface TurnSummary {
  runId: string;
  tier: TurnTier;
  /** The model's concise final summary (the loop's last assistant message). */
  narrative: string;
  changedFiles: ChangedFile[];
  checks: TurnCheck[];
  metrics: TurnMetrics;
  /** How many mutating tools were declined at the confirmation gate. */
  declined: number;
  nextHint: NextHint | null;
  startedAt: string;
  completedAt: string | null;
}

// --- diffstat ----------------------------------------------------------------

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

/**
 * Parses a unified diff into per-file diffstat. Tolerant of partial/odd diffs:
 * a malformed hunk never throws, it just yields the best counts available.
 * Status is `added` when the old side is `/dev/null`, `deleted` when the new
 * side is, else `modified`.
 */
export function parseDiffStat(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | null = null;

  const flush = (): void => {
    if (current !== null) {
      files.push(current);
      current = null;
    }
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      // `diff --git a/x b/y` → provisional path from the b-side.
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      const path = match?.[2] ?? match?.[1] ?? '(unknown)';
      current = { path, status: 'modified', insertions: 0, deletions: 0 };
      continue;
    }
    if (current === null) {
      continue;
    }
    if (line.startsWith('--- ')) {
      if (line === '--- /dev/null') {
        current.status = 'added';
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (line === '+++ /dev/null') {
        current.status = 'deleted';
      } else {
        const path = line.slice(4).replace(/^b\//, '').trim();
        if (path.length > 0 && path !== '/dev/null') {
          current.path = path;
        }
      }
      continue;
    }
    // Hunk body: count real additions/removals (never the +++/--- headers).
    if (line.startsWith('+')) {
      current.insertions += 1;
    } else if (line.startsWith('-')) {
      current.deletions += 1;
    }
  }
  flush();
  return files;
}

// --- check extraction --------------------------------------------------------

function checksFrom(events: ExcaliburEvent[]): TurnCheck[] {
  const checks: TurnCheck[] = [];
  for (const event of events) {
    if (event.type === 'command_completed') {
      const label = str(event, 'command') ?? '(command)';
      const exit = num(event, 'exitCode');
      checks.push({
        label,
        ok: exit === 0,
        detail: exit === null ? null : exit === 0 ? 'exit 0' : `exit ${exit}`,
      });
    } else if (event.type === 'test_result') {
      const status = str(event, 'status') ?? 'unknown';
      const passed = num(event, 'passed');
      const total = num(event, 'total');
      const detail =
        passed !== null && total !== null
          ? `${passed}/${total} passed`
          : passed !== null
            ? `${passed} passed`
            : status;
      checks.push({ label: 'tests', ok: status === 'passed', detail });
    }
  }
  return checks;
}

// --- changed files -----------------------------------------------------------

/**
 * Resolves the files the turn changed. The accumulated diff (best-effort, from
 * the replay model) is the authority for diffstat; when the producer recorded a
 * `patch_generated` with `filesAffected` but no usable diff (e.g. the offline
 * mock, or a redacted-to-empty diff), fall back to those paths with zero stats
 * so the file LIST is still correct even when the line counts are unknown.
 */
function changedFilesFrom(model: ReplayModel, events: ExcaliburEvent[]): ChangedFile[] {
  const lastIndex = model.steps.length - 1;
  const diff = lastIndex >= 0 ? reconstructStateAt(model, lastIndex).accumulatedDiff : '';
  const fromDiff = parseDiffStat(diff);
  if (fromDiff.length > 0) {
    return fromDiff;
  }

  // No parseable diff — recover the path list from patch_generated/file_write.
  const paths = new Set<string>();
  for (const event of events) {
    if (event.type === 'patch_generated' || event.type === 'patch_applied') {
      const affected = event.payload['filesAffected'];
      if (Array.isArray(affected)) {
        for (const p of affected) {
          if (typeof p === 'string' && p.length > 0) {
            paths.add(p);
          }
        }
      }
    } else if (event.type === 'file_write' && event.payload['ok'] === true) {
      const p = str(event, 'path');
      if (p !== null && p.length > 0) {
        paths.add(p);
      }
    }
  }
  return [...paths].sort().map((path) => ({
    path,
    status: 'modified' as const,
    insertions: 0,
    deletions: 0,
  }));
}

// --- tier + next hint --------------------------------------------------------

function lastAssistant(events: ExcaliburEvent[]): ExcaliburEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as ExcaliburEvent;
    if (event.type === 'assistant_message') {
      return event;
    }
  }
  return null;
}

function tierOf(
  events: ExcaliburEvent[],
  assistant: ExcaliburEvent | null,
  changedFiles: ChangedFile[],
  checks: TurnCheck[],
): TurnTier {
  // 'failed' covers both a hard error (provider/tool error, `errored` flag) AND
  // a failing check (tests red, non-zero command): honesty-first — the headline
  // must not show a reassuring ✓ when something the turn ran did not pass.
  const errored =
    assistant?.payload['errored'] === true || events.some((e) => e.type === 'error');
  if (errored || checks.some((check) => !check.ok)) {
    return 'failed';
  }
  if (assistant?.payload['aborted'] === true || assistant?.payload['truncated'] === true) {
    return 'partial';
  }
  if (changedFiles.length > 0 || checks.length > 0) {
    return 'action';
  }
  return 'answer';
}

function nextHintOf(
  runId: string,
  events: ExcaliburEvent[],
  changedFiles: ChangedFile[],
  checks: TurnCheck[],
): NextHint | null {
  if (checks.some((check) => !check.ok)) {
    return { kind: 'fix_failures' };
  }
  if (changedFiles.length === 0) {
    return null;
  }
  // Already applied to the tree → nothing to apply.
  const applied = events.some((e) => e.type === 'patch_applied');
  if (!applied) {
    return { kind: 'apply', runId };
  }
  const branch = events.find((e) => e.type === 'branch_created');
  if (branch !== undefined) {
    const name = str(branch, 'branch') ?? str(branch, 'name');
    if (name !== null) {
      return { kind: 'branch', branch: name };
    }
  }
  return null;
}

// --- public builder ----------------------------------------------------------

/**
 * Builds the deterministic {@link TurnSummary} for a run from its replay model.
 * Pure — never throws on a sparse/partial log (an empty run yields an `answer`
 * tier with an empty narrative).
 */
export function buildTurnSummary(model: ReplayModel): TurnSummary {
  const events = model.steps.map((step) => step.event);
  const assistant = lastAssistant(events);
  const narrative = assistant !== null ? str(assistant, 'content') ?? '' : '';

  const changedFiles = changedFilesFrom(model, events);
  const checks = checksFrom(events);

  const lastStep = model.steps[model.steps.length - 1];
  const tokens = lastStep?.tokensSoFar ?? { input: 0, output: 0 };
  const costCents = lastStep?.costCentsSoFar ?? null;

  const declined = events.filter(
    (e) =>
      e.type === 'policy_decision' &&
      e.payload['kind'] === 'confirmation' &&
      e.payload['decision'] === 'deny',
  ).length;

  const metrics: TurnMetrics = {
    files: changedFiles.length,
    insertions: changedFiles.reduce((sum, file) => sum + file.insertions, 0),
    deletions: changedFiles.reduce((sum, file) => sum + file.deletions, 0),
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    costCents,
  };

  return {
    runId: model.run.id,
    tier: tierOf(events, assistant, changedFiles, checks),
    narrative: narrative.trim(),
    changedFiles,
    checks,
    metrics,
    declined,
    nextHint: nextHintOf(model.run.id, events, changedFiles, checks),
    startedAt: model.run.startedAt,
    completedAt: model.run.completedAt,
  };
}

/** Single-letter status glyph for a changed file (git-style). */
export function changeGlyph(status: ChangedFile['status']): 'A' | 'M' | 'D' {
  return status === 'added' ? 'A' : status === 'deleted' ? 'D' : 'M';
}

/**
 * Serializes a summary to the `summary.md` artifact (canonical, locale-neutral
 * English headings). Persisted into the run dir so the receipt survives in the
 * time-machine and syncs to Enterprise.
 */
export function turnSummaryToMarkdown(summary: TurnSummary): string {
  const lines: string[] = [];
  lines.push(`# Run ${summary.runId} — ${summary.tier}`);
  lines.push('');
  if (summary.narrative.length > 0) {
    lines.push(summary.narrative);
    lines.push('');
  }
  if (summary.changedFiles.length > 0) {
    lines.push(`## Changed (${summary.metrics.files} files, +${summary.metrics.insertions} −${summary.metrics.deletions})`);
    for (const file of summary.changedFiles) {
      lines.push(`- ${changeGlyph(file.status)} ${file.path}  +${file.insertions} −${file.deletions}`);
    }
    lines.push('');
  }
  if (summary.checks.length > 0) {
    lines.push('## Checks');
    for (const check of summary.checks) {
      lines.push(`- ${check.ok ? '✓' : '✗'} ${check.label}${check.detail !== null ? ` · ${check.detail}` : ''}`);
    }
    lines.push('');
  }
  const cost = summary.metrics.costCents !== null ? `$${(summary.metrics.costCents / 100).toFixed(2)}` : '—';
  lines.push(
    `## Cost\n${summary.metrics.inputTokens + summary.metrics.outputTokens} tokens · ${cost}`,
  );
  return `${lines.join('\n')}\n`;
}
