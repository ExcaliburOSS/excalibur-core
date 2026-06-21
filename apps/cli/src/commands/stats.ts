import { collectInsights } from '@excalibur/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { CliDeps } from '../deps';

/**
 * `excalibur stats [--since <iso>] [--json]` (P1.12) — historical run analytics
 * over `.excalibur/runs/`: totals, completion rate, cost/tokens, and breakdowns
 * by workflow, model and day. A read-only projection of `collectInsights` (the
 * same aggregate the web dashboard folds), surfaced for the terminal.
 */
function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function registerStatsCommand(program: Command, deps: CliDeps): void {
  program
    .command('stats')
    .description('historical run stats — cost, tokens, completion, by workflow/model/day')
    .option('--since <iso>', 'only count runs started on/after this ISO date')
    .option('--json', 'machine-readable JSON output')
    .action((options: { since?: string; json?: boolean }) => {
      const insights = collectInsights(
        deps.cwd(),
        options.since !== undefined ? { sinceIso: options.since } : {},
      );
      if (options.json === true) {
        deps.ui.json(insights);
        return;
      }
      if (insights.totalRuns === 0) {
        deps.ui.info('No runs yet — run a task to start collecting stats.');
        return;
      }
      deps.ui.heading('Run stats');
      deps.ui.write(
        `  runs ${insights.totalRuns}  ·  completion ${Math.round(insights.completionRate * 100)}%  ·  spend ${dollars(insights.totalCostCents)}`,
      );
      deps.ui.write(
        `  tokens ↑${insights.totalInputTokens} ↓${insights.totalOutputTokens}  ·  model calls ${insights.totalModelCalls}  ·  files changed ${insights.totalFilesChanged}`,
      );
      const statuses = Object.entries(insights.byStatus)
        .map(([status, n]) => `${status} ${n}`)
        .join('  ');
      if (statuses.length > 0) {
        deps.ui.write(`  status: ${statuses}`);
      }
      if (insights.byWorkflow.length > 0) {
        deps.ui.write();
        deps.ui.write(pc.dim('by workflow:'));
        for (const w of insights.byWorkflow) {
          deps.ui.write(`  ${w.key}  ${w.runs} runs · ${dollars(w.costCents)}`);
        }
      }
      if (insights.byModel.length > 0) {
        deps.ui.write();
        deps.ui.write(pc.dim('by model:'));
        for (const m of insights.byModel) {
          deps.ui.write(
            `  ${m.key}  ${m.runs} runs · ${dollars(m.costCents)} · ↑${m.inputTokens} ↓${m.outputTokens}`,
          );
        }
      }
      if (insights.byDay.length > 0) {
        deps.ui.write();
        deps.ui.write(pc.dim('recent days:'));
        for (const d of insights.byDay.slice(-14)) {
          deps.ui.write(`  ${d.day}  ${d.runs} runs · ${dollars(d.costCents)}`);
        }
      }
    });
}
