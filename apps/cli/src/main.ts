#!/usr/bin/env node
import { CommanderError } from 'commander';
import { isExcaliburError } from '@excalibur/shared';
import { createUi } from './ui';
import { defaultDeps } from './deps';
import { buildProgram } from './program';
import { parseInteractiveArgs, runInteractiveSession } from './session/repl';
import { EXIT_SUCCESS, describeError, exitCodeForError } from './errors';

function stdinIsTty(): boolean {
  return process.stdin.isTTY === true;
}

/**
 * Excalibur CLI entry point. CommonJS-compatible (no top-level await):
 * `main()` is invoked and its rejection mapped onto the contract exit codes
 * (0 success · 1 runtime error · 2 usage/validation).
 */
function main(): void {
  const ui = createUi();

  // No-subcommand + TTY → the interactive conversational session. Without a
  // TTY (piped/CI) we keep the existing Commander no-arg help behavior.
  const interactiveOptions = parseInteractiveArgs(process.argv);
  if (interactiveOptions !== null && stdinIsTty()) {
    const deps = defaultDeps({ ui });
    runInteractiveSession(deps, interactiveOptions)
      .then((code) => {
        process.exitCode = code;
      })
      .catch((error: unknown) => {
        ui.error(describeError(error));
        if (isExcaliburError(error)) {
          ui.info(`(${error.code})`);
        }
        process.exitCode = exitCodeForError(error);
      });
    return;
  }

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
