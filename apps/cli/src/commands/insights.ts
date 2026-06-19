import { collectInsights, type CountCost, type InsightsReport } from '@excalibur/core';
import { formatCents, formatTokens } from '@excalibur/tui';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { CliDeps } from '../deps';

/**
 * `excalibur insights [--since <Nd|Nh>] [--json]` — the CROSS-RUN lens (plan
 * P2.5). Folds the whole `.excalibur/runs/` history into spend, tokens,
 * completion rate, per-model + per-workflow breakdowns and a per-day trend.
 * Unlike Claude Code's session-only `/usage`, this spans every run on disk —
 * and it's the OSS seed of the Enterprise 5-lens Insights dashboard (same
 * `aggregateInsights`). `--json` is the scriptable surface.
 */
export function registerInsightsCommand(program: Command, deps: CliDeps): void {
  program
    .command('insights')
    .description('cross-run cost/token/outcome lens over the whole .excalibur/runs history')
    .option('--since <window>', 'only runs within a window, e.g. 7d or 24h')
    .option('--json', 'machine-readable JSON output')
    .action((options: { since?: string; json?: boolean }) => {
      const repoRoot = deps.cwd();
      const sinceIso = options.since !== undefined ? windowToIso(options.since, deps) : undefined;
      const report = collectInsights(repoRoot, sinceIso !== undefined ? { sinceIso } : {});

      if (options.json === true) {
        deps.ui.json(report);
        return;
      }
      if (report.totalRuns === 0) {
        deps.ui.info(deps.t('insights.no-runs'));
        return;
      }
      render(deps, report);
    });
}

/** Converts a `7d` / `24h` window into an ISO cutoff (relative to now). */
function windowToIso(window: string, deps: CliDeps): string | undefined {
  const match = /^(\d+)\s*([dh])$/.exec(window.trim());
  if (match === null) {
    deps.ui.warn(deps.t('insights.since-invalid', { window }));
    return undefined;
  }
  const amount = Number.parseInt(match[1] as string, 10);
  const ms = (match[2] === 'd' ? 86_400_000 : 3_600_000) * amount;
  return new Date(Date.now() - ms).toISOString();
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function render(deps: CliDeps, report: InsightsReport): void {
  const { ui, t } = deps;
  ui.write();
  ui.heading(t('insights.title', { runs: report.totalRuns }));

  // Headline metrics.
  const status = Object.entries(report.byStatus)
    .map(([key, n]) => `${n} ${key}`)
    .join(' · ');
  ui.write(`  ${pc.dim(t('insights.status'))}  ${status}`);
  ui.write(
    `  ${pc.dim(t('insights.completion'))}  ${pct(report.completionRate)}  ${pc.dim(
      `(${report.totalVerificationsBlocked} ${t('insights.blocked')})`,
    )}`,
  );
  ui.write(
    `  ${pc.dim(t('insights.spend'))}  ${formatCents(report.totalCostCents)}  ${pc.dim(
      t('insights.avg', { cost: formatCents(report.avgCostCentsPerRun) }),
    )}`,
  );
  ui.write(
    `  ${pc.dim(t('insights.tokens'))}  ${formatTokens(report.totalInputTokens)}↑ ${formatTokens(
      report.totalOutputTokens,
    )}↓  ${pc.dim(`${report.totalModelCalls} ${t('insights.calls')}`)}`,
  );
  ui.write(
    `  ${pc.dim(t('insights.activity'))}  ${report.totalFilesChanged} ${t(
      'insights.files',
    )} · ${report.totalApprovals} ${t('insights.approvals')}`,
  );

  // Breakdowns.
  const breakdown = (titleKey: string, rows: ReadonlyArray<CountCost>): void => {
    if (rows.length === 0) return;
    ui.write();
    ui.write(pc.bold(t(titleKey)));
    ui.table(
      [
        t('insights.col-name'),
        t('insights.col-runs'),
        t('insights.col-cost'),
        t('insights.col-tokens'),
      ],
      rows.map((r) => [
        r.key,
        String(r.runs),
        formatCents(r.costCents),
        `${formatTokens(r.inputTokens)}↑ ${formatTokens(r.outputTokens)}↓`,
      ]),
    );
  };
  breakdown('insights.by-model', report.byModel);
  breakdown('insights.by-workflow', report.byWorkflow);

  // Trend: a compact per-day sparkline of run counts.
  if (report.byDay.length > 1) {
    ui.write();
    ui.write(pc.bold(t('insights.trend')));
    const max = Math.max(...report.byDay.map((d) => d.runs));
    for (const day of report.byDay) {
      const bar = sparkBar(day.runs, max);
      ui.write(`  ${pc.dim(day.day)}  ${bar} ${day.runs}  ${pc.dim(formatCents(day.costCents))}`);
    }
  }
  ui.write();
}

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** A single-cell-height bar scaled to the max (ASCII '#'/'.' when unicode is off). */
function sparkBar(value: number, max: number): string {
  if (max <= 0) return '';
  const ascii = process.env['EXCALIBUR_ASCII'] !== undefined;
  const ratio = value / max;
  const width = Math.max(1, Math.round(ratio * 16));
  if (ascii) return '#'.repeat(width);
  const tier = Math.min(BLOCKS.length - 1, Math.max(0, Math.round(ratio * (BLOCKS.length - 1))));
  return (BLOCKS[tier] as string).repeat(width);
}
