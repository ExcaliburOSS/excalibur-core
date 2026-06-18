import { describe, expect, it } from 'vitest';
import type { DiagnosticsPayload } from '@excalibur/shared';
import { diagnosticsContextSource, lspDiagnosticsContextSource, runDiagnostics } from './diagnostics';

const node = process.execPath;

describe('runDiagnostics', () => {
  it('returns ran:false when no command is configured', () => {
    expect(runDiagnostics(process.cwd(), undefined)).toEqual({
      ran: false,
      ok: null,
      output: '',
      diagnostics: [],
    });
  });

  // These spawn a real `node` subprocess; under full-suite parallel load (other
  // suites also spawn processes) node startup can exceed the 5s default → flaky.
  // A generous timeout keeps them reliable (in isolation they run in ~80ms).
  it('captures a clean typecheck (exit 0)', () => {
    const result = runDiagnostics(process.cwd(), `${node} -e ""`);
    expect(result.ran).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  }, 30000);

  it('captures a failing typecheck (non-zero) and parses tsc-style errors', () => {
    const script = `process.stdout.write('src/x.ts(3,5): error TS2304: Cannot find name foo.\\nsrc/y.ts(10,1): error TS1005: ; expected.\\n'); process.exit(2)`;
    const result = runDiagnostics(process.cwd(), `${node} -e "${script}"`);
    expect(result.ran).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Cannot find name foo');
    expect(result.diagnostics).toEqual([
      { file: 'src/x.ts', line: 3, message: 'Cannot find name foo.' },
      { file: 'src/y.ts', line: 10, message: '; expected.' },
    ]);
  }, 30000);
});

describe('diagnosticsContextSource', () => {
  it('is null when not run or clean', () => {
    expect(diagnosticsContextSource({ ran: false, ok: null, output: '', diagnostics: [] })).toBeNull();
    expect(diagnosticsContextSource({ ran: true, ok: true, output: '', diagnostics: [] })).toBeNull();
  });

  it('formats the real output when there are errors', () => {
    const source = diagnosticsContextSource({
      ran: true,
      ok: false,
      output: 'src/x.ts(3,5): error TS2304: Cannot find name foo.',
      diagnostics: [{ file: 'src/x.ts', line: 3, message: 'Cannot find name foo.' }],
    });
    expect(source).not.toBeNull();
    expect(source?.title).toContain('Compiler diagnostics');
    expect(source?.content).toContain('Cannot find name foo');
    expect(source?.content).toContain('anchor your review');
  });
});

describe('lspDiagnosticsContextSource', () => {
  const payload = (over: Partial<DiagnosticsPayload>): DiagnosticsPayload => ({
    file: 'src/x.ts',
    diagnostics: [],
    errorCount: 0,
    warningCount: 0,
    ...over,
  });

  it('is null when no changed file carries an error/warning', () => {
    expect(lspDiagnosticsContextSource([])).toBeNull();
    expect(lspDiagnosticsContextSource([payload({})])).toBeNull(); // clean file
    // info/hint only → no noise.
    expect(
      lspDiagnosticsContextSource([
        payload({ diagnostics: [{ line: 1, column: 1, severity: 'info', message: 'fyi' }] }),
      ]),
    ).toBeNull();
  });

  it('renders error/warning diagnostics per changed file (anchored, with location)', () => {
    const source = lspDiagnosticsContextSource([
      payload({
        file: 'src/a.ts',
        diagnostics: [{ line: 3, column: 9, severity: 'error', message: 'Type mismatch', code: 'TS2322' }],
        errorCount: 1,
      }),
      payload({ file: 'src/clean.ts' }), // clean → omitted
    ]);
    expect(source).not.toBeNull();
    expect(source?.title).toContain('language server');
    expect(source?.content).toContain('src/a.ts:3:9 error: Type mismatch [TS2322]');
    expect(source?.content).toContain('anchor your');
    expect(source?.content).not.toContain('src/clean.ts');
    expect(source?.precedence).toBe(6);
  });
});
