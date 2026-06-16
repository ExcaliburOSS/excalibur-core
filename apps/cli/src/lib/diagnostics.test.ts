import { describe, expect, it } from 'vitest';
import { diagnosticsContextSource, runDiagnostics } from './diagnostics';

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

  it('captures a clean typecheck (exit 0)', () => {
    const result = runDiagnostics(process.cwd(), `${node} -e ""`);
    expect(result.ran).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

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
  });
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
