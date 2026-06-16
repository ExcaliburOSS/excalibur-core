import { RunManager } from '@excalibur/core';
import {
  isAutonomyLevel,
  type AutonomyLevel,
  type ExecutionStyle,
  type OutputType,
  outputTypeSchema,
} from '@excalibur/shared';
import type { Command } from 'commander';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import { runTask, type RunTaskOptions } from '../lib/run-pipeline';
import {
  emitRunOutput,
  parseOutputFormat,
  quietDepsForMachineOutput,
  type RunOutputFormat,
} from '../lib/run-output';

interface RunOptions {
  level?: string;
  fast?: boolean;
  careful?: boolean;
  structured?: boolean;
  explore?: boolean;
  workflow?: string;
  output?: string;
  outputFormat?: string;
  yes?: boolean;
  sync?: boolean;
}

function parseLevel(value: string | undefined): AutonomyLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!isAutonomyLevel(parsed)) {
    throw new CliUsageError(`--level must be 0..4 (got "${value}").`);
  }
  return parsed;
}

function parseOutput(value: string | undefined): OutputType | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = outputTypeSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliUsageError(
      `--output must be one of: ${outputTypeSchema.options.join(', ')} (got "${value}").`,
    );
  }
  return parsed.data;
}

function styleFromFlags(options: RunOptions): ExecutionStyle | undefined {
  const picked: ExecutionStyle[] = [];
  if (options.fast === true) picked.push('fast');
  if (options.careful === true) picked.push('careful');
  if (options.structured === true) picked.push('structured');
  if (options.explore === true) picked.push('explore');
  if (picked.length > 1) {
    throw new CliUsageError('Use at most one of --fast / --careful / --structured / --explore.');
  }
  return picked[0];
}

/**
 * `excalibur run "<task>"` (Build Contract §4.9). This Commander action is a
 * thin wrapper: it parses/validates the flags and delegates the orchestration
 * to {@link runTask} (`lib/run-pipeline.ts`), which the interactive M-Shell
 * REPL reuses. Behavior and output are identical to the inlined version.
 */
export function registerRunCommand(program: Command, deps: CliDeps): void {
  program
    .command('run')
    .description('run a local agentic workflow for a task (Level 3/4)')
    .argument('<task...>', 'the task to run')
    .option('--level <0-4>', 'autonomy level (0..4)')
    .option('--fast', 'fast execution style (fast-fix)')
    .option('--careful', 'careful execution style (Level 4, stronger approvals)')
    .option('--structured', 'structured execution style (structured-feature)')
    .option('--explore', 'explore engineering alternatives')
    .option('--workflow <id>', 'use an explicit workflow id')
    .option(
      '--output <type>',
      'desired output type (branch|pull_request|patch|review|plan|alternatives)',
    )
    .option(
      '--output-format <text|json|stream-json>',
      'output format for CI/scripts: text (default), json (full run as one JSON doc), stream-json (one event per line)',
    )
    .option('--sync', 'push the finished run to Excalibur Enterprise (experimental)')
    .option('-y, --yes', 'skip prompts and accept safe defaults')
    .action(async (taskWords: string[], options: RunOptions) => {
      const task = taskWords.join(' ').trim();
      if (task.length === 0) {
        throw new CliUsageError('The task must not be empty.');
      }

      const explicitLevel = parseLevel(options.level);
      parseOutput(options.output);
      const explicitStyle = styleFromFlags(options);
      const outputFormat: RunOutputFormat = parseOutputFormat(options.outputFormat) ?? 'text';

      const taskOptions: RunTaskOptions = {
        ...(explicitLevel !== undefined ? { level: explicitLevel } : {}),
        ...(explicitStyle !== undefined ? { style: explicitStyle } : {}),
        ...(options.workflow !== undefined ? { workflow: options.workflow } : {}),
        ...(options.yes === true ? { yes: true } : {}),
        ...(options.sync === true ? { sync: true } : {}),
      };

      // `text` is unchanged: the run streams human output through deps.ui.
      if (outputFormat === 'text') {
        await runTask(deps, task, taskOptions);
        return;
      }

      // Machine-readable formats (json / stream-json) are PROJECTIONS of the
      // same run: execute it with a quiet Ui so the human chatter never
      // corrupts the JSON a consumer is parsing, then emit the persisted event
      // stream (events.jsonl) in the requested shape through the real stdout.
      const record = await runTask(quietDepsForMachineOutput(deps), task, taskOptions);
      if (record === null) {
        // The run was cancelled or diverted to Discovery — no run, no events.
        return;
      }
      const runManager = new RunManager(deps.cwd());
      const events = runManager.readEvents(record.id);
      emitRunOutput(deps.ui, outputFormat, { run: record, events });
    });
}
