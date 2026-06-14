import { loadAnnotations, loadReplay } from '@excalibur/core';
import type { Command } from 'commander';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import {
  printLinearSummary,
  printStateAt,
  resolveRun,
  runScrubber,
} from '../lib/replay-scrubber';

interface ReplayOptions {
  print?: boolean;
  at?: string;
}

/**
 * `excalibur replay [id]` — the time-machine. Rewinds a run like a video:
 * scrub step-by-step, semantic-jump (next edit / test / command / failure /
 * approval / phase), EXPLAIN at the cursor (mock offline, real provider live),
 * view the accumulated diff and pin annotations. Defaults to the latest run.
 *
 * Interactive on a TTY (a readline scrubber). NON-INTERACTIVE — when stdin is
 * not a TTY, or `--print` / `--at <n>` is given — it prints a static linear
 * summary of all steps (or the reconstructed state at step n) and exits, so it
 * is fully scriptable and testable without a live terminal.
 */
export function registerReplayCommand(program: Command, deps: CliDeps): void {
  program
    .command('replay')
    .description('rewind a run step-by-step — replay · inspect · explain · annotate (the time-machine)')
    .argument('[id]', 'run id (defaults to the latest run)')
    .option('--print', 'print a static linear summary of every step and exit (non-interactive)')
    .option('--at <n>', 'print the reconstructed state at step n (1-based) and exit')
    .action(async (id: string | undefined, options: ReplayOptions) => {
      const { id: runId } = resolveRun(deps, id);
      const repoRoot = deps.cwd();

      // `--at <n>`: reconstruct and print the state at a single step.
      if (options.at !== undefined) {
        const at = Number.parseInt(options.at, 10);
        if (Number.isNaN(at) || at < 1) {
          throw new CliUsageError(`--at must be a positive step number (got "${options.at}").`);
        }
        const replay = loadReplay(repoRoot, runId);
        printStateAt(deps, replay, loadAnnotations(repoRoot, runId), at - 1);
        return;
      }

      // `--print` or a non-TTY stdin: static, scriptable linear summary.
      if (options.print === true || !deps.ui.isInteractive()) {
        const replay = loadReplay(repoRoot, runId);
        printLinearSummary(deps, replay, loadAnnotations(repoRoot, runId));
        return;
      }

      // Interactive scrubber: open a persistent line editor and drive the loop.
      const editor = deps.ui.openLineEditor();
      try {
        await runScrubber(deps, runId, {
          question: (prompt: string): Promise<string | null> => editor.question(prompt),
        });
      } finally {
        editor.close();
      }
    });
}
