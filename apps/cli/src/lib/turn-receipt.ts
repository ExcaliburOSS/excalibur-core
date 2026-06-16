import type { ChangedFile, NextHint, TurnCheck, TurnSummary } from '@excalibur/core';
import pc from 'picocolors';
import type { CliDeps } from '../deps';

/**
 * The post-turn receipt renderer (M-Shell DX, "light" treatment).
 *
 * Renders the deterministic {@link TurnSummary} (built from the event stream in
 * `@excalibur/core`) as a compact, glanceable recap after a turn of agentic
 * work. The treatment SCALES to the work so it is never cargante:
 *  - an `answer` turn (no changes) prints just the answer + one dim footer line;
 *  - an `action`/`partial`/`failed` turn adds a one-line metrics summary, an
 *    aligned (capped) file list and a single next-step hint;
 *  - failures lead (amber/red glyph) and are never buried.
 * The full file list + diff live behind `/changes` (progressive disclosure).
 *
 * All user-facing strings live HERE (the core model is locale-neutral data), so
 * the M2 i18n pass localizes the receipt by swapping this renderer's catalog.
 */

/** How many changed files to list inline before deferring the rest to `/changes`. */
const FILE_LIST_CAP = 8;
/** Pad file paths to this column so the diffstat aligns. */
const PATH_COLUMN = 32;

export interface ReceiptOptions {
  /** Current time, for the relative "Xs ago" footer (injected for testability). */
  now: Date;
  /** Model/provider name shown in the footer. */
  model: string;
}

/** Compact token count (`12.4k`, `340`). */
function compactTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

/** `$0.04`, or `—` when no call carried a cost. */
function formatCost(costCents: number | null): string {
  return costCents === null ? '—' : `$${(costCents / 100).toFixed(2)}`;
}

/** Elapsed wall-time `1m48s` / `4.2s`, or null when timestamps are missing. */
function formatDuration(startedAt: string, completedAt: string | null): string | null {
  if (completedAt === null) {
    return null;
  }
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    return null;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
}

/** Relative "just now / 2s ago / 14:32" + absolute clock for the footer. */
function formatWhen(now: Date, completedAt: string | null): string {
  const at = completedAt !== null ? new Date(completedAt) : now;
  const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const deltaSec = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));
  const rel =
    deltaSec < 2
      ? 'just now'
      : deltaSec < 60
        ? `${deltaSec}s ago`
        : deltaSec < 3600
          ? `${Math.floor(deltaSec / 60)}m ago`
          : `${Math.floor(deltaSec / 3600)}h ago`;
  return `${rel} · ${clock}`;
}

/** The leading glyph + color for the headline, by tier. */
function headline(summary: TurnSummary): string {
  const text = summary.narrative.length > 0 ? summary.narrative : defaultNarrative(summary);
  switch (summary.tier) {
    case 'action':
      return `${pc.green('✓')} ${text}`;
    case 'failed':
      return `${pc.red('✗')} ${pc.red(text)}`;
    case 'partial':
      return `${pc.yellow('◑')} ${text}`;
    case 'answer':
      return text;
  }
}

/** A sensible headline when the model returned no final prose. */
function defaultNarrative(summary: TurnSummary): string {
  switch (summary.tier) {
    case 'action':
      return 'Changes applied.';
    case 'failed':
      return 'The turn ended with an error.';
    case 'partial':
      return 'The turn stopped before finishing.';
    case 'answer':
      return 'Done.';
  }
}

/** The single most-relevant check for the metrics line (a failure always wins). */
function primaryCheck(checks: TurnCheck[]): TurnCheck | null {
  if (checks.length === 0) {
    return null;
  }
  const failed = checks.find((check) => !check.ok);
  return failed ?? (checks[checks.length - 1] as TurnCheck);
}

/** `✓ tests 142 passed` / `✗ npm build exit 1`. */
function renderCheck(check: TurnCheck): string {
  const glyph = check.ok ? pc.green('✓') : pc.red('✗');
  const detail = check.detail !== null ? ` ${check.detail}` : '';
  const body = `${check.label}${detail}`;
  return `${glyph} ${check.ok ? body : pc.red(body)}`;
}

/** The compact one-line metrics summary (files · diffstat · check · cost). */
function metricsLine(summary: TurnSummary): string {
  const parts: string[] = [];
  const { metrics } = summary;
  if (metrics.files > 0) {
    const fileWord = metrics.files === 1 ? 'file' : 'files';
    parts.push(
      `${metrics.files} ${fileWord} · ${formatPairStat(metrics.insertions, metrics.deletions)}`,
    );
  }
  const check = primaryCheck(summary.checks);
  if (check !== null) {
    parts.push(renderCheck(check));
  }
  if (summary.declined > 0) {
    parts.push(pc.yellow(`${summary.declined} declined`));
  }
  const tokens = metrics.inputTokens + metrics.outputTokens;
  const cost = `${compactTokens(tokens)} tok · ${formatCost(metrics.costCents)}`;
  const duration = formatDuration(summary.startedAt, summary.completedAt);
  parts.push(pc.dim(duration !== null ? `${cost} · ${duration}` : cost));
  return parts.join('   ');
}

/** An aligned changed-file row: `M  src/x.ts        +12 −3`. */
function fileRow(file: ChangedFile): string {
  const glyph =
    file.status === 'added'
      ? pc.green('A')
      : file.status === 'deleted'
        ? pc.red('D')
        : pc.yellow('M');
  const path =
    file.path.length > PATH_COLUMN
      ? `…${file.path.slice(-(PATH_COLUMN - 1))}`
      : file.path.padEnd(PATH_COLUMN);
  const stat = formatPairStat(file.insertions, file.deletions);
  return `   ${glyph}  ${path}  ${stat}`;
}

/** Diffstat for a row: omits a zero side (`+28`, `−6`, `+12 −3`, or a dim dot). */
function formatPairStat(insertions: number, deletions: number): string {
  if (insertions === 0 && deletions === 0) {
    return pc.dim('·');
  }
  const parts: string[] = [];
  if (insertions > 0) {
    parts.push(pc.green(`+${insertions}`));
  }
  if (deletions > 0) {
    parts.push(pc.red(`−${deletions}`));
  }
  return parts.join(' ');
}

/** Maps the structured next-hint to a localized one-liner. */
function renderNextHint(hint: NextHint): string {
  switch (hint.kind) {
    case 'apply':
      return `review, then  excalibur apply ${hint.runId}`;
    case 'fix_failures':
      return 'address the failing checks above';
    case 'branch':
      return `changes are on branch ${hint.branch}`;
    case 'resolve_block':
      return 'resolve the block to continue';
  }
}

/**
 * Renders the post-turn receipt to the terminal. Returns nothing; the caller
 * already finished the run. Never throws on a sparse summary.
 */
export function renderTurnReceipt(
  deps: CliDeps,
  summary: TurnSummary,
  options: ReceiptOptions,
): void {
  const { ui } = deps;
  ui.write();
  ui.write(` ${headline(summary)}`);

  // Answer turns stop at the headline + footer (anti-cargante).
  if (summary.tier !== 'answer') {
    ui.write(`   ${metricsLine(summary)}`);

    if (summary.changedFiles.length > 0) {
      ui.write();
      for (const file of summary.changedFiles.slice(0, FILE_LIST_CAP)) {
        ui.write(fileRow(file));
      }
      const extra = summary.changedFiles.length - FILE_LIST_CAP;
      if (extra > 0) {
        ui.write(pc.dim(`   …and ${extra} more · /changes`));
      }
    }

    if (summary.nextHint !== null) {
      ui.write();
      ui.write(
        `   ${pc.cyan('→')} ${renderNextHint(summary.nextHint)}${pc.dim('     /changes · /rewind')}`,
      );
    }
  }

  // Dim footer: relative+absolute time · model. (A subtle rule precedes it.)
  ui.write(pc.dim(' ' + '─'.repeat(48)));
  ui.write(pc.dim(` ${formatWhen(options.now, summary.completedAt)} · ${options.model}`));
}
