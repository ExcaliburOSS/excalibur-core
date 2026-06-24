import { detectColorTier, detectThemeSync, renderChronogram } from '@excalibur/tui';
import type { Command } from 'commander';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import { buildChronogramForRun } from '../lib/chronogram';
import { latestOrchestrationRunId, setOrchestrationPaused } from '../lib/orchestration-manifest';

/**
 * `excalibur orchestration [runId] [--json]` (AO6 Pillar 2) — render a swarm
 * orchestration as a wave/DAG CHRONOGRAM: the dependency waves, each lane's
 * state · duration · cost, and the fan-in summary. Defaults to the latest swarm.
 * The SAME `ChronogramDto` powers the live dashboard timeline, so the two views
 * stay aligned (one model, two presenters). An escape hatch — the chronogram is
 * also surfaced proactively/over NL and in the dashboard.
 */
export function registerOrchestrationCommand(program: Command, deps: CliDeps): void {
  program
    .command('orchestration')
    .alias('chronogram')
    .description('show a swarm orchestration as a wave/DAG chronogram (defaults to the latest)')
    .argument('[runId]', 'parent (swarm) run id')
    .option('--json', 'machine-readable JSON output')
    .option('--pause', 'pause this orchestration mid-flight (a live swarm stops dispatching lanes)')
    .option('--resume', 'resume a paused orchestration (a held swarm continues)')
    .action(
      (
        runIdArg: string | undefined,
        options: { json?: boolean; pause?: boolean; resume?: boolean },
      ) => {
        const repoRoot = deps.cwd();
        const runId = runIdArg ?? latestOrchestrationRunId(repoRoot);
        if (runId === null) {
          throw new CliUsageError(deps.t('orchestration.none'));
        }
        // Pause/resume just toggle the persisted control flag — a LIVE swarm's
        // lane gate polls it and holds/continues. (After-the-fact re-dispatch of
        // a finished orchestration is `excalibur orchestrate --resume`.)
        if (options.pause === true || options.resume === true) {
          const paused = options.pause === true;
          const ok = setOrchestrationPaused(repoRoot, runId, paused, new Date().toISOString());
          if (!ok) {
            throw new CliUsageError(deps.t('orchestration.notFound', { id: runId }));
          }
          deps.ui.info(
            deps.t(paused ? 'orchestration.pause-set' : 'orchestration.resume-set', { id: runId }),
          );
          return;
        }
        renderChronogramView(deps, repoRoot, runId, options.json === true);
      },
    );
}

/** Renders a run's chronogram to the UI (shared by the command + the REPL NL route). */
export function renderChronogramView(
  deps: CliDeps,
  repoRoot: string,
  runId: string,
  asJson: boolean,
): void {
  const chronogram = buildChronogramForRun(repoRoot, runId);
  if (chronogram === null) {
    throw new CliUsageError(deps.t('orchestration.notFound', { id: runId }));
  }
  if (asJson) {
    deps.ui.json(chronogram);
    return;
  }
  deps.ui.heading(
    deps.t('orchestration.heading', {
      id: chronogram.parentRunId,
      task: chronogram.task,
      status: chronogram.paused ? deps.t('chronogram.paused') : chronogram.status,
    }),
  );
  for (const line of renderChronogram(chronogram, {
    tier: detectColorTier(),
    mode: detectThemeSync() ?? 'dark',
    nowMs: Date.now(),
    labels: {
      chronogram: deps.t('chronogram.title'),
      wave: deps.t('chronogram.wave'),
      depends: deps.t('chronogram.depends'),
      done: deps.t('chronogram.done'),
      running: deps.t('chronogram.running'),
      failed: deps.t('chronogram.failed'),
      pending: deps.t('chronogram.pending'),
      paused: deps.t('chronogram.paused'),
    },
  })) {
    deps.ui.write(line);
  }
}
