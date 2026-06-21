import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadExtensions } from '@excalibur/extension-runtime';
import { activateExtensions } from './activate';

/**
 * End-to-end: a REAL local extension on disk (manifest + compiled JS entrypoint)
 * is discovered by the runtime loader and ACTIVATED by `activateExtensions`, and
 * the tool it registers is harvested and executable. This exercises the full
 * loader → activation → harvest path the CLI uses, not hand-built registries.
 */

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'excalibur-ext-int-'));
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

/**
 * Writes a programmatic extension. The entrypoint is plain CJS that exports the
 * extension shape directly (no SDK import needed — `defineExtension` only freezes
 * the same `{ id, name, version, register }` object the loader/activation accept),
 * so the test needs no build step or module resolution into the workspace.
 */
function writeExtension(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'excalibur.extension.yaml'),
    [
      'id: demo-tools',
      'name: Demo Tools',
      'version: 1.0.0',
      'kind: programmatic',
      'entrypoint: index.js',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'index.js'),
    `module.exports = {
  id: 'demo-tools',
  name: 'Demo Tools',
  version: '1.0.0',
  register(ctx) {
    ctx.tools.registerTool({
      name: 'echo',
      description: 'Echo the input back',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      readOnly: true,
      execute: (input) => Promise.resolve({ success: true, output: 'echo:' + JSON.stringify(input) }),
    });
  },
};
`,
  );
}

describe('activateExtensions — real on-disk extension', () => {
  it('loads, activates, and executes a tool from a compiled entrypoint', async () => {
    writeExtension(join(repoRoot, '.excalibur', 'extensions', 'demo-tools'));

    const registry = await loadExtensions({ repoRoot, builtIns: [] });
    // The loader recorded the extension as loaded with a usable instance.
    const ext = registry.getExtension('demo-tools');
    expect(ext?.status).toBe('loaded');

    const { tools, warnings } = await activateExtensions(registry);
    expect(warnings).toHaveLength(0);
    const echo = tools.find((t) => t.name === 'echo');
    expect(echo).toBeDefined();
    expect(echo?.readOnly).toBe(true);

    const result = await echo?.execute(
      { msg: 'hi' },
      {
        workdir: repoRoot,
        config: {},
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      },
    );
    expect(result?.success).toBe(true);
    expect(result?.output).toBe('echo:{"msg":"hi"}');
  });
});
