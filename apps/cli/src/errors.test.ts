import { CommanderError } from 'commander';
import {
  CommandParseError,
  ConfigValidationError,
  ExcaliburError,
  WorkflowValidationError,
} from '@excalibur/shared';
import { describe, expect, it } from 'vitest';
import {
  CliUsageError,
  EXIT_RUNTIME_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  describeError,
  exitCodeForError,
} from './errors';

describe('exit codes (Build Contract §4.9: 0 success, 1 runtime, 2 usage)', () => {
  it('maps usage/validation errors to exit 2', () => {
    expect(exitCodeForError(new CliUsageError('bad flag'))).toBe(EXIT_USAGE_ERROR);
    expect(exitCodeForError(new ConfigValidationError('bad config'))).toBe(EXIT_USAGE_ERROR);
    expect(exitCodeForError(new WorkflowValidationError('bad workflow'))).toBe(EXIT_USAGE_ERROR);
    expect(exitCodeForError(new CommandParseError('bad command'))).toBe(EXIT_USAGE_ERROR);
  });

  it('maps runtime errors to exit 1', () => {
    expect(exitCodeForError(new ExcaliburError('boom', 'doctor_failed'))).toBe(EXIT_RUNTIME_ERROR);
    expect(exitCodeForError(new Error('boom'))).toBe(EXIT_RUNTIME_ERROR);
    expect(exitCodeForError('boom')).toBe(EXIT_RUNTIME_ERROR);
  });

  it('maps commander help/version to success and usage errors to 2', () => {
    expect(exitCodeForError(new CommanderError(0, 'commander.helpDisplayed', 'help'))).toBe(
      EXIT_SUCCESS,
    );
    expect(exitCodeForError(new CommanderError(0, 'commander.version', 'v'))).toBe(EXIT_SUCCESS);
    expect(exitCodeForError(new CommanderError(1, 'commander.unknownCommand', 'nope'))).toBe(
      EXIT_USAGE_ERROR,
    );
    expect(exitCodeForError(new CommanderError(1, 'commander.missingArgument', 'arg'))).toBe(
      EXIT_USAGE_ERROR,
    );
  });

  it('CliUsageError is an ExcaliburError with a stable code', () => {
    const error = new CliUsageError('nope', { flag: '--level' });
    expect(error).toBeInstanceOf(ExcaliburError);
    expect(error.code).toBe('cli_usage');
    expect(error.details).toEqual({ flag: '--level' });
  });

  it('describes errors without leaking stacks', () => {
    expect(describeError(new Error('plain message'))).toBe('plain message');
    expect(describeError('text')).toBe('text');
  });
});
