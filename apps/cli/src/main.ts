#!/usr/bin/env node
import { CommanderError } from 'commander';
import { isExcaliburError } from '@excalibur/shared';
import { createUi } from './ui';
import { buildProgram } from './program';
import { EXIT_SUCCESS, describeError, exitCodeForError } from './errors';

/**
 * Excalibur CLI entry point. CommonJS-compatible (no top-level await):
 * `main()` is invoked and its rejection mapped onto the contract exit codes
 * (0 success · 1 runtime error · 2 usage/validation).
 */
function main(): void {
  const ui = createUi();
  const program = buildProgram({ ui });

  program
    .parseAsync(process.argv)
    .then(() => {
      process.exitCode = process.exitCode ?? EXIT_SUCCESS;
    })
    .catch((error: unknown) => {
      const exitCode = exitCodeForError(error);
      if (error instanceof CommanderError) {
        // Commander already printed help/usage through configureOutput.
        process.exitCode = exitCode;
        return;
      }
      ui.error(describeError(error));
      if (isExcaliburError(error)) {
        ui.info(`(${error.code})`);
      }
      ui.info('Run `excalibur doctor` to diagnose your setup.');
      process.exitCode = exitCode;
    });
}

main();
