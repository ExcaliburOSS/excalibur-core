import type { ScopeComplexity } from '@excalibur/core';
import type { Command } from 'commander';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import { runScopeFlow } from '../lib/scope';

/**
 * `excalibur scope "<task>"` (AO9-2) — the "Understand-first" surface. Fans out
 * an auto-dimensioned, READ-ONLY exploration of the repo (one explorer per
 * angle, sized to the task's complexity), then prints a ScopeMap: relevant
 * subsystems → files, what EXISTS vs what's MISSING, risks and open questions.
 * No code is written — this is the read phase BEFORE planning/building. `--json`
 * for machine output; `--angles <n>` / `--complexity` override the auto-sizing.
 */
export function registerScopeCommand(program: Command, deps: CliDeps): void {
  program
    .command('scope')
    .description(
      'read-only "Understand-first" scope of a task (subsystems, built vs missing, risks)',
    )
    .argument('<task...>', 'the task to scope')
    .option('--json', 'machine-readable JSON output')
    .option('--angles <n>', 'override the auto-dimensioned explorer count (1-8)')
    .option('--complexity <level>', 'force complexity: small | medium | large')
    .action(
      async (
        taskWords: string[],
        options: { json?: boolean; angles?: string; complexity?: string },
      ) => {
        const task = taskWords.join(' ').trim();
        if (task.length === 0) {
          throw new CliUsageError(deps.t('scope.taskEmpty'));
        }
        await runScopeFlow(deps, task, {
          json: options.json === true,
          ...(options.angles !== undefined ? { angles: parseAngles(options.angles) } : {}),
          ...(options.complexity !== undefined
            ? { complexity: parseComplexity(options.complexity) }
            : {}),
        });
      },
    );
}

function parseAngles(value: string): number {
  // Reject non-integers explicitly — Number.parseInt would silently truncate
  // "3.5"→3 / "3abc"→3, contradicting the "must be an integer" error message.
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new CliUsageError(`--angles must be an integer between 1 and 8 (got "${value}").`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < 1 || parsed > 8) {
    throw new CliUsageError(`--angles must be an integer between 1 and 8 (got "${value}").`);
  }
  return parsed;
}

function parseComplexity(value: string): ScopeComplexity {
  const normalized = value.toLowerCase();
  if (normalized === 'small' || normalized === 'medium' || normalized === 'large') {
    return normalized;
  }
  throw new CliUsageError(`--complexity must be one of small | medium | large (got "${value}").`);
}
