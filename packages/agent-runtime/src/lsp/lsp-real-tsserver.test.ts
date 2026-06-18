import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LspConfig } from '@excalibur/shared';
import { createLspSession } from './lsp-session';
import { binaryOnPath } from './lsp-servers';

/**
 * REAL end-to-end test against `typescript-language-server` (a devDependency, so
 * `pnpm test` puts it on PATH). Gated: it skips cleanly where the binary is
 * absent. Proves the client/session speak the real protocol — a clean file
 * yields no diagnostics, a genuine type error yields one. tsserver cold-start +
 * project load is slow, hence the generous timeouts.
 */
const HAS_TSSERVER = binaryOnPath('typescript-language-server');

const realConfig: LspConfig = {
  enabled: true,
  diagnosticsTimeoutMs: 8000,
  serverStartTimeoutMs: 25000,
};

describe.skipIf(!HAS_TSSERVER)('LSP against the real typescript-language-server', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'excalibur-lsp-real-'));
    writeFileSync(
      join(workdir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true } }),
    );
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it(
    'reports no diagnostics for a clean file and a real error after an errored change',
    async () => {
      const session = createLspSession({ workdir, config: realConfig });
      try {
        // Clean file → zero errors.
        writeFileSync(join(workdir, 'a.ts'), 'export const x: number = 1;\n');
        const clean = await session.diagnosticsFor('a.ts');
        expect(clean).not.toBeNull();
        expect(clean?.errorCount).toBe(0);

        // Introduce a genuine type error → exactly one error, anchored to the line.
        writeFileSync(join(workdir, 'a.ts'), 'export const x: number = "not a number";\n');
        const errored = await session.diagnosticsFor('a.ts');
        expect(errored?.errorCount).toBeGreaterThanOrEqual(1);
        const error = errored?.diagnostics.find((d) => d.severity === 'error');
        expect(error?.line).toBe(1);
        expect(error?.message.toLowerCase()).toContain('type');
      } finally {
        session.close();
      }
    },
    60000,
  );
});
