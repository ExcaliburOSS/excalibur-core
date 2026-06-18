import { describe, expect, it } from 'vitest';
import { dirname, isAbsolute } from 'node:path';
import { binaryOnPath, languageForFile, resolveBinary, resolveServerFor } from './lsp-servers';

describe('languageForFile', () => {
  it('maps known extensions to a language id', () => {
    expect(languageForFile('src/a.ts')).toBe('typescript');
    expect(languageForFile('a.TSX')).toBe('typescript'); // case-insensitive
    expect(languageForFile('x.mjs')).toBe('javascript');
    expect(languageForFile('s.py')).toBe('python');
    expect(languageForFile('m.go')).toBe('go');
    expect(languageForFile('l.rs')).toBe('rust');
  });

  it('returns null for unsupported files', () => {
    expect(languageForFile('README.md')).toBeNull();
    expect(languageForFile('data.json')).toBeNull();
    expect(languageForFile('noext')).toBeNull();
  });
});

describe('resolveServerFor', () => {
  it('defaults TS and JS to the shared typescript-language-server', () => {
    const ts = resolveServerFor('typescript');
    const js = resolveServerFor('javascript');
    expect(ts?.command).toBe('typescript-language-server');
    expect(ts?.args).toEqual(['--stdio']);
    expect(ts?.serverKey).toBe('typescript');
    expect(js?.serverKey).toBe('typescript'); // same server instance
    expect(js?.languageId).toBe('javascript'); // but tagged javascript
  });

  it('applies a per-language command override (keeping the server key + languageId)', () => {
    const over = resolveServerFor('typescript', {
      typescript: { command: '/opt/tsserver', args: ['--lsp'] },
    });
    expect(over?.command).toBe('/opt/tsserver');
    expect(over?.args).toEqual(['--lsp']);
    expect(over?.serverKey).toBe('typescript');
    expect(over?.languageId).toBe('typescript');
  });

  it('returns null for an unknown language', () => {
    expect(resolveServerFor('cobol')).toBeNull();
  });
});

describe('binaryOnPath', () => {
  it('finds a bare command on PATH (point PATH at the dir of node itself)', () => {
    const original = process.env['PATH'];
    try {
      process.env['PATH'] = dirname(process.execPath);
      const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
      expect(binaryOnPath(nodeName)).toBe(true);
    } finally {
      process.env['PATH'] = original;
    }
  });

  it('checks an absolute path directly', () => {
    expect(binaryOnPath(process.execPath)).toBe(true);
    expect(binaryOnPath('/definitely/not/here/xyzzy-langserver')).toBe(false);
  });

  it('returns false for a missing bare command', () => {
    expect(binaryOnPath('definitely-not-a-real-language-server-xyzzy')).toBe(false);
    expect(binaryOnPath('')).toBe(false);
  });
});

describe('resolveBinary', () => {
  it('always returns an ABSOLUTE path, even when PATH has a relative entry', () => {
    const original = process.env['PATH'];
    try {
      // A RELATIVE PATH entry must still resolve to an absolute path (else a
      // spawn with a different cwd would look in the wrong directory).
      process.env['PATH'] = './node_modules/.bin';
      // node itself lives in an absolute dir; resolving it must stay absolute.
      const resolved = resolveBinary(process.execPath);
      expect(resolved).not.toBeNull();
      expect(isAbsolute(resolved as string)).toBe(true);
    } finally {
      process.env['PATH'] = original;
    }
  });

  it('returns null for a missing command', () => {
    expect(resolveBinary('definitely-not-installed-xyzzy')).toBeNull();
  });
});
