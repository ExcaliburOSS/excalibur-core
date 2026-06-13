import { CommanderError } from 'commander';
import {
  CommandParseError,
  ConfigValidationError,
  ExcaliburError,
  WorkflowValidationError,
  isExcaliburError,
} from '@excalibur/shared';

/**
 * CLI exit codes (Build Contract §4.9):
 * 0 — success · 1 — runtime error · 2 — usage/validation error.
 */
export const EXIT_SUCCESS = 0;
export const EXIT_RUNTIME_ERROR = 1;
export const EXIT_USAGE_ERROR = 2;

/** Thrown for bad CLI usage (unknown ids, invalid flag values, …) → exit 2. */
export class CliUsageError extends ExcaliburError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'cli_usage', details);
  }
}

/** Commander codes that mean "help/version displayed", not an error. */
const COMMANDER_OK_CODES = new Set(['commander.helpDisplayed', 'commander.help', 'commander.version']);

/** Maps any thrown value onto the contract exit codes. */
export function exitCodeForError(error: unknown): number {
  if (error instanceof CommanderError) {
    if (COMMANDER_OK_CODES.has(error.code) && error.exitCode === 0) {
      return EXIT_SUCCESS;
    }
    return EXIT_USAGE_ERROR;
  }
  if (
    error instanceof CliUsageError ||
    error instanceof ConfigValidationError ||
    error instanceof WorkflowValidationError ||
    error instanceof CommandParseError
  ) {
    return EXIT_USAGE_ERROR;
  }
  return EXIT_RUNTIME_ERROR;
}

/** Human-friendly message for a thrown value (never a raw stack by default). */
export function describeError(error: unknown): string {
  if (isExcaliburError(error)) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
