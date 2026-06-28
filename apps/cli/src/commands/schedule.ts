import type { Command } from 'commander';
import {
  advanceJob,
  describeSpec,
  dueJobs,
  nextRun,
  parseScheduleSpec,
  RunController,
  ScheduleStore,
  type ScheduledJob,
} from '@excalibur/core';
import { generateId } from '@excalibur/shared';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { loadConfigContext, loadGatewayContext, requireConfiguredModel } from '../lib/context';

/**
 * AO8-3 — `excalibur schedule` — autonomous scheduled jobs (the OSS analog of
 * CC's cron/ScheduleWakeup). A job fires a task on a cadence ("every 30m",
 * "at 09:00"); `schedule run` is the long-lived daemon that ticks, starts the due
 * jobs as real runs (via RunController), and reschedules them. Off by default —
 * nothing fires unless you add a job AND keep `schedule run` (or `serve`) alive.
 */
export function registerScheduleCommand(program: Command, deps: CliDeps): void {
  const schedule = program
    .command('schedule')
    .description('autonomous scheduled jobs (run a task every N, or daily at HH:MM)');

  schedule
    .command('add')
    .description('add a scheduled job, e.g. `schedule add "every 2h" "run the test sweep"`')
    .argument('<spec>', 'cadence: "every 30m" / "2h" / "at 09:00" / "daily 14:30"')
    .argument('<task...>', 'the task to run when it fires')
    .action((spec: string, taskWords: string[]) => {
      const parsed = parseScheduleSpec(spec);
      if (parsed === null) {
        throw new CliUsageError(deps.t('schedule.invalid-spec', { spec }));
      }
      const task = taskWords.join(' ').trim();
      if (task.length === 0) {
        throw new CliUsageError(deps.t('schedule.needs-task'));
      }
      const now = Date.now();
      const job: ScheduledJob = {
        id: generateId('sched'),
        task,
        spec: parsed,
        createdAtMs: now,
        lastRunMs: null,
        nextRunMs: nextRun(parsed, now),
        enabled: true,
      };
      new ScheduleStore(deps.cwd()).add(job);
      deps.ui.success(
        deps.t('schedule.added', {
          id: job.id,
          spec: describeSpec(parsed),
          next: new Date(job.nextRunMs).toLocaleString(),
        }),
      );
    });

  schedule
    .command('list')
    .description('list scheduled jobs')
    .action(() => {
      const jobs = new ScheduleStore(deps.cwd()).list();
      if (jobs.length === 0) {
        deps.ui.info(deps.t('schedule.list-empty'));
        return;
      }
      for (const j of jobs) {
        deps.ui.write(
          `${j.id}  ${describeSpec(j.spec)}  ·  next ${new Date(j.nextRunMs).toLocaleString()}\n    ${j.task}`,
        );
      }
    });

  schedule
    .command('remove')
    .alias('rm')
    .description('remove a scheduled job by id')
    .argument('<id>', 'the job id (from `schedule list`)')
    .action((id: string) => {
      const removed = new ScheduleStore(deps.cwd()).remove(id);
      deps.ui[removed ? 'success' : 'warn'](
        deps.t(removed ? 'schedule.removed' : 'schedule.not-found', { id }),
      );
    });

  schedule
    .command('run')
    .description('the scheduler daemon: fire due jobs on a tick (blocks until Ctrl-C)')
    .option('--tick <seconds>', 'how often to check for due jobs', '30')
    .action(async (options: { tick?: string }) => {
      const repoRoot = deps.cwd();
      const gateway = loadGatewayContext(repoRoot);
      requireConfiguredModel(gateway, deps.t); // a scheduler driving the mock is pointless
      const { config } = loadConfigContext(repoRoot);
      const store = new ScheduleStore(repoRoot);
      const controller = new RunController();
      const tickMs = Math.max(1000, (Number.parseInt(options.tick ?? '30', 10) || 30) * 1000);

      let stop = false;
      const onSignal = (): void => {
        stop = true;
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));

      try {
        deps.ui.success(
          deps.t('schedule.daemon-start', { count: store.list().length, tick: tickMs / 1000 }),
        );
        while (!stop) {
          const now = Date.now();
          for (const job of dueJobs(store.list(), now)) {
            deps.ui.info(deps.t('schedule.firing', { task: job.task }));
            try {
              const handle = await controller.startRun({
                repoRoot,
                task: job.task,
                gateway: gateway.gateway,
                config,
                model: gateway.providerName,
              });
              deps.ui.write(deps.t('schedule.fired', { runId: handle.runId }));
            } catch (error) {
              deps.ui.error(error instanceof Error ? error.message : String(error));
            }
            store.update(advanceJob(job, now)); // reschedule even on a failed fire
          }
          // Sleep in short slices so Ctrl-C is responsive.
          for (let waited = 0; waited < tickMs && !stop; waited += 1000) {
            await sleep(Math.min(1000, tickMs - waited));
          }
        }
        deps.ui.info(deps.t('schedule.daemon-stop'));
      } finally {
        // Never leak the process listeners (they would accumulate if this daemon
        // is ever driven in-process rather than as a one-shot CLI invocation).
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
      }
    });
}
