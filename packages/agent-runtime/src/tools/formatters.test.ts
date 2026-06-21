import { describe, expect, it, vi } from 'vitest';
import { formatFile, hasFormatterFor } from './formatters';

describe('formatters', () => {
  it('knows which extensions have a formatter', () => {
    expect(hasFormatterFor('src/app.ts')).toBe(true);
    expect(hasFormatterFor('main.go')).toBe(true);
    expect(hasFormatterFor('lib.rs')).toBe(true);
    expect(hasFormatterFor('s.py')).toBe(true);
    expect(hasFormatterFor('notes.txt')).toBe(false);
    expect(hasFormatterFor('Makefile')).toBe(false);
  });

  it('runs the resolved formatter on a known extension', async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    const result = await formatFile('/repo/src/app.ts', {
      workdir: '/repo',
      resolveBin: (spec) => `/repo/node_modules/.bin/${spec.bin}`,
      exec,
    });
    expect(result).toEqual({ formatted: true, formatter: 'prettier' });
    expect(exec).toHaveBeenCalledWith(
      '/repo/node_modules/.bin/prettier',
      ['--write', '/repo/src/app.ts'],
      '/repo',
    );
  });

  it('uses gofmt -w for Go files', async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    await formatFile('/repo/main.go', { workdir: '/repo', resolveBin: (s) => s.bin, exec });
    expect(exec).toHaveBeenCalledWith('gofmt', ['-w', '/repo/main.go'], '/repo');
  });

  it('is a no-op for an unknown extension', async () => {
    const exec = vi.fn();
    expect(await formatFile('/repo/notes.txt', { workdir: '/repo', exec })).toEqual({
      formatted: false,
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('is a no-op when the formatter is not available', async () => {
    const exec = vi.fn();
    const result = await formatFile('/repo/app.ts', {
      workdir: '/repo',
      resolveBin: () => null,
      exec,
    });
    expect(result).toEqual({ formatted: false });
    expect(exec).not.toHaveBeenCalled();
  });

  it('never throws when the formatter fails (returns not-formatted)', async () => {
    const result = await formatFile('/repo/app.ts', {
      workdir: '/repo',
      resolveBin: (s) => s.bin,
      exec: () => Promise.reject(new Error('syntax error')),
    });
    expect(result).toEqual({ formatted: false, formatter: 'prettier' });
  });
});
