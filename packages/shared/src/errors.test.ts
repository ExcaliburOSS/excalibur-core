import { describe, expect, it } from 'vitest';
import {
  CommandParseError,
  ConfigValidationError,
  ExcaliburError,
  isExcaliburError,
  PermissionDeniedError,
  ProviderError,
  RunNotFoundError,
  WorkflowValidationError,
} from './errors';

describe('ExcaliburError', () => {
  it('carries message, stable code and optional details', () => {
    const error = new ExcaliburError('boom', 'custom_code', { runId: 'run_1' });
    expect(error.message).toBe('boom');
    expect(error.code).toBe('custom_code');
    expect(error.details).toEqual({ runId: 'run_1' });
    expect(error).toBeInstanceOf(Error);
  });

  it('leaves details undefined when not provided', () => {
    const error = new ExcaliburError('boom', 'custom_code');
    expect(error.details).toBeUndefined();
  });

  it('every subclass keeps the instanceof chain through Error and ExcaliburError', () => {
    const errors: ExcaliburError[] = [
      new ConfigValidationError('bad config'),
      new WorkflowValidationError('bad workflow'),
      new PermissionDeniedError('denied'),
      new ProviderError('provider failed'),
      new RunNotFoundError('missing run'),
      new CommandParseError('bad command'),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ExcaliburError);
    }
  });

  it('subclasses expose the pinned stable codes', () => {
    expect(new ConfigValidationError('x').code).toBe('config_validation');
    expect(new WorkflowValidationError('x').code).toBe('workflow_validation');
    expect(new PermissionDeniedError('x').code).toBe('permission_denied');
    expect(new ProviderError('x').code).toBe('provider_error');
    expect(new RunNotFoundError('x').code).toBe('run_not_found');
    expect(new CommandParseError('x').code).toBe('command_parse');
  });

  it('subclasses report their own class name', () => {
    expect(new RunNotFoundError('x').name).toBe('RunNotFoundError');
    expect(new ProviderError('x').name).toBe('ProviderError');
    expect(new ExcaliburError('x', 'c').name).toBe('ExcaliburError');
  });

  it('ProviderError supports narrowed codes for not-implemented and sync failures', () => {
    const notImplemented = new ProviderError('real providers arrive in OSS-4 (M2)', {
      code: 'provider_not_implemented',
      details: { provider: 'anthropic' },
    });
    expect(notImplemented.code).toBe('provider_not_implemented');
    expect(notImplemented.details).toEqual({ provider: 'anthropic' });

    const syncFailed = new ProviderError('sync failed', { code: 'sync_failed' });
    expect(syncFailed.code).toBe('sync_failed');
  });

  it('subclass details are preserved', () => {
    const error = new PermissionDeniedError('write blocked', { path: '.env', op: 'write' });
    expect(error.details).toEqual({ path: '.env', op: 'write' });
  });

  it('isExcaliburError narrows correctly', () => {
    expect(isExcaliburError(new CommandParseError('x'))).toBe(true);
    expect(isExcaliburError(new Error('plain'))).toBe(false);
    expect(isExcaliburError('string')).toBe(false);
    expect(isExcaliburError(null)).toBe(false);
  });
});
