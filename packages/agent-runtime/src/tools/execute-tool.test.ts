import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type ExcaliburConfig } from '@excalibur/shared';
import { PermissionEngine } from '../permissions/permission-engine';
import { executeNativeTool, type ToolExecutionContext } from './execute-tool';

/**
 * Direct, offline coverage of the real tool executors (the security-critical
 * core). Each test exercises one executor against a real temp directory and
 * asserts the security invariants: path confinement, permission gate, output
 * caps and secret redaction.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'excalibur-exec-tool-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(config: ExcaliburConfig = permissive()): ToolExecutionContext {
  return {
    workdir: dir,
    config,
    permissions: new PermissionEngine(config.permissions),
  };
}

function permissive(): ExcaliburConfig {
  return {
    ...DEFAULT_CONFIG,
    permissions: {
      ...DEFAULT_CONFIG.permissions,
      tools: {
        ...DEFAULT_CONFIG.permissions?.tools,
        write_file: true,
        run_command: true,
        apply_patch: true,
        create_branch: true,
        run_tests: true,
      },
      allowedCommands: ['*'],
    },
  };
}

describe('executeNativeTool — argument validation', () => {
  it('rejects malformed arguments before doing anything', async () => {
    const result = await executeNativeTool('read_file', { wrong: 1 }, ctx());
    expect(result.ok).toBe(false);
    expect(result.result).toContain('invalid arguments');
  });
});

describe('executeNativeTool — error message sanitization', () => {
  it('surfaces a GENERIC message on a thrown fs error, never the raw host path', async () => {
    // A readable-stat but unreadable file: statSync succeeds, readFileSync throws
    // EACCES whose raw message embeds the absolute host path. The catch handler
    // must map it to a generic phrase and never echo the path.
    const secretPath = join(dir, 'no-read.txt');
    writeFileSync(secretPath, 'top secret contents');
    chmodSync(secretPath, 0o000);
    try {
      const result = await executeNativeTool('read_file', { path: 'no-read.txt' }, ctx());
      expect(result.ok).toBe(false);
      // Generic phrase derived from the errno code (EACCES → "access denied").
      expect(result.result).toContain('access denied');
      // The raw host path must NOT leak into the result.
      expect(result.result).not.toContain(secretPath);
      expect(result.result).not.toContain(dir);
    } finally {
      chmodSync(secretPath, 0o600);
    }
  });
});

describe('executeNativeTool — read_file', () => {
  it('reads a confined file', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello');
    const result = await executeNativeTool('read_file', { path: 'a.txt' }, ctx());
    expect(result.ok).toBe(true);
    expect(result.result).toBe('hello');
  });

  it('redacts secrets in file contents', async () => {
    const key = `sk-${'b'.repeat(40)}`;
    writeFileSync(join(dir, 'secret.ts'), `const k='${key}';`);
    const result = await executeNativeTool('read_file', { path: 'secret.ts' }, ctx());
    expect(result.result).toContain('[REDACTED]');
    expect(result.result).not.toContain(key);
  });

  it('denies a blocked path (.env)', async () => {
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    const result = await executeNativeTool('read_file', { path: '.env' }, ctx());
    expect(result.ok).toBe(false);
    expect(result.result).toContain('permission denied');
  });

  it('rejects absolute and traversal paths', async () => {
    const abs = await executeNativeTool('read_file', { path: '/etc/passwd' }, ctx());
    expect(abs.ok).toBe(false);
    expect(abs.result).toContain('absolute');
    const up = await executeNativeTool('read_file', { path: '../../etc/passwd' }, ctx());
    expect(up.ok).toBe(false);
    expect(up.result).toContain('escapes the working directory');
  });

  it('refuses to follow a symlink that escapes the tree', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'excalibur-outside-'));
    writeFileSync(join(outside, 'target.txt'), 'leaked');
    try {
      symlinkSync(join(outside, 'target.txt'), join(dir, 'link.txt'));
      const result = await executeNativeTool('read_file', { path: 'link.txt' }, ctx());
      expect(result.ok).toBe(false);
      expect(result.result).toContain('symlink');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('truncates files larger than the cap', async () => {
    const big = 'x'.repeat(300 * 1024);
    writeFileSync(join(dir, 'big.txt'), big);
    const result = await executeNativeTool('read_file', { path: 'big.txt' }, ctx());
    expect(result.ok).toBe(true);
    expect(result.result).toContain('truncated');
  });
});

describe('executeNativeTool — write_file', () => {
  it('creates parent directories within the tree', async () => {
    const result = await executeNativeTool(
      'write_file',
      { path: 'src/nested/x.ts', content: 'export const x = 1;' },
      ctx(),
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, 'src/nested/x.ts'), 'utf8')).toBe('export const x = 1;');
  });

  it('denies a write to a blocked path and never writes', async () => {
    const result = await executeNativeTool('write_file', { path: '.env', content: 'x' }, ctx());
    expect(result.ok).toBe(false);
    expect(existsSync(join(dir, '.env'))).toBe(false);
  });

  it('rejects a traversal write without touching the fs', async () => {
    const result = await executeNativeTool(
      'write_file',
      { path: '../escape.txt', content: 'x' },
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(existsSync(join(dir, '../escape.txt'))).toBe(false);
  });

  it('refuses to write through a symlink that points outside the tree (O_NOFOLLOW)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'excalibur-outside-'));
    writeFileSync(join(outside, 'external.txt'), 'original');
    try {
      // A symlink INSIDE the tree whose target is OUTSIDE the tree. O_NOFOLLOW
      // makes the open fail (ELOOP) on the symlink leaf, closing the TOCTOU race.
      symlinkSync(join(outside, 'external.txt'), join(dir, 'link.txt'));
      const result = await executeNativeTool(
        'write_file',
        { path: 'link.txt', content: 'PWNED' },
        ctx(),
      );
      expect(result.ok).toBe(false);
      expect(result.result).toContain('symlink');
      // The external file must be UNTOUCHED — the write never followed the link.
      expect(readFileSync(join(outside, 'external.txt'), 'utf8')).toBe('original');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('executeNativeTool — list_files & search_code', () => {
  beforeEach(() => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\nconst found = true;\n');
    writeFileSync(join(dir, 'src/b.js'), 'const b = 2;\n');
    mkdirSync(join(dir, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/pkg/index.js'), 'module.exports = {};\n');
  });

  it('lists files, skipping node_modules, with a glob filter', async () => {
    const result = await executeNativeTool('list_files', { glob: 'src/**/*.ts' }, ctx());
    expect(result.ok).toBe(true);
    expect(result.result).toContain('src/a.ts');
    expect(result.result).not.toContain('b.js');
    expect(result.result).not.toContain('node_modules');
  });

  it('searches code by string and returns path:line: snippet', async () => {
    const result = await executeNativeTool('search_code', { query: 'found' }, ctx());
    expect(result.ok).toBe(true);
    expect(result.result).toMatch(/src\/a\.ts:2: /);
    expect(result.result).not.toContain('node_modules');
  });

  it('searches code by /regex/', async () => {
    const result = await executeNativeTool('search_code', { query: '/const \\w+ = \\d/' }, ctx());
    expect(result.ok).toBe(true);
    expect(result.result).toContain('src/a.ts');
  });

  it('never reads a blocked path into search results', async () => {
    writeFileSync(join(dir, '.env'), 'API_KEY=needle\n');
    const result = await executeNativeTool('search_code', { query: 'needle' }, ctx());
    expect(result.result).not.toContain('.env');
  });

  it('rejects an overly long regex pattern (ReDoS bound) but keeps normal patterns working', async () => {
    // A pathologically long regex source is the classic catastrophic-backtracking
    // vector — it must be rejected before compiling.
    const longPattern = `/${'a'.repeat(300)}/`;
    const rejected = await executeNativeTool('search_code', { query: longPattern }, ctx());
    expect(rejected.ok).toBe(false);
    expect(rejected.result).toContain('regex too long');

    // A normal regex still works.
    const normal = await executeNativeTool('search_code', { query: '/const \\w+ = \\d/' }, ctx());
    expect(normal.ok).toBe(true);
    expect(normal.result).toContain('src/a.ts');
  });

  it('bounds the directory-walk depth so a deep tree cannot exhaust the stack', async () => {
    // Build a tree deeper than MAX_WALK_DEPTH (100): files past the limit are not
    // returned, but the walk returns early instead of recursing without bound.
    let deep = dir;
    for (let i = 0; i < 130; i += 1) {
      deep = join(deep, `d${i}`);
    }
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'too-deep.txt'), 'buried\n');
    // Must not throw / overflow; the over-limit file is simply not surfaced.
    const list = await executeNativeTool('list_files', {}, ctx());
    expect(list.ok).toBe(true);
    expect(list.result).not.toContain('too-deep.txt');
    const search = await executeNativeTool('search_code', { query: 'buried' }, ctx());
    expect(search.ok).toBe(true);
    expect(search.result).toContain('(no matches)');
  });
});

describe('executeNativeTool — run_command / run_tests', () => {
  it('runs an allowlisted command and captures output', async () => {
    const result = await executeNativeTool('run_command', { command: 'echo hello-world' }, ctx());
    expect(result.ok).toBe(true);
    expect(result.result).toContain('hello-world');
    expect(result.result).toContain('exit code: 0');
  });

  it('reports a non-zero exit as ok:false with output', async () => {
    const result = await executeNativeTool('run_command', { command: 'exit 3' }, ctx());
    expect(result.ok).toBe(false);
    expect(result.result).toContain('exit code: 3');
  });

  it('denies a command outside the allowlist', async () => {
    const restricted: ExcaliburConfig = {
      ...DEFAULT_CONFIG,
      permissions: {
        ...DEFAULT_CONFIG.permissions,
        tools: { ...DEFAULT_CONFIG.permissions?.tools, run_command: false },
      },
    };
    const result = await executeNativeTool('run_command', { command: 'echo x' }, ctx(restricted));
    expect(result.ok).toBe(false);
    expect(result.result).toContain('permission denied');
  });

  it('redacts secrets printed by a command', async () => {
    const key = `ghp_${'c'.repeat(36)}`;
    const result = await executeNativeTool('run_command', { command: `echo ${key}` }, ctx());
    expect(result.result).not.toContain(key);
    expect(result.result).toContain('[REDACTED]');
  });

  it('run_tests uses the detected test command from config', async () => {
    const cfg = permissive();
    cfg.commands = { test: 'echo TESTS_RAN' };
    const result = await executeNativeTool('run_tests', {}, ctx(cfg));
    expect(result.result).toContain('TESTS_RAN');
  });

  it('SIGKILLs an in-flight command when the run is aborted (does not wait for the process)', async () => {
    const controller = new AbortController();
    const abortCtx: ToolExecutionContext = { ...ctx(), signal: controller.signal };
    setTimeout(() => controller.abort(), 50);
    const startedAt = Date.now();
    // `sleep 30` would block for 30s (and the executor's own timeout is 120s);
    // an honoured abort must kill it long before either. The bound is generous
    // (and the test timeout larger still) so a saturated CI runner's spawn/timer
    // latency can't flake it — but a *dropped* abort still fails hard, because
    // the command would then run on to the 120s executor timeout.
    const result = await executeNativeTool('run_command', { command: 'sleep 30' }, abortCtx);
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(10000);
    expect(result.result).toContain('aborted');
  }, 20000);

  it('kills the whole process tree on abort, not just the shell (no orphaned child)', async () => {
    const controller = new AbortController();
    const abortCtx: ToolExecutionContext = { ...ctx(), signal: controller.signal };
    setTimeout(() => controller.abort(), 50);
    const startedAt = Date.now();
    // `sleep 30 & wait` makes the shell FORK a long-lived child rather than
    // exec into it (as a simple command would on some shells). Killing only the
    // shell would orphan that child, which keeps the inherited stdio pipes open
    // so Node's 'close' never fires and the run hangs to the 120s timeout. The
    // process-group SIGKILL must reap the whole tree. (This is the dash-on-CI
    // shape that a bare `sleep 30` doesn't reproduce under bash.)
    const result = await executeNativeTool('run_command', { command: 'sleep 30 & wait' }, abortCtx);
    expect(Date.now() - startedAt).toBeLessThan(10000);
    expect(result.result).toContain('aborted');
  }, 20000);

  it('does not start a command when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const abortCtx: ToolExecutionContext = { ...ctx(), signal: controller.signal };
    const result = await executeNativeTool(
      'run_command',
      { command: 'echo should-not-run' },
      abortCtx,
    );
    // The "before start" marker is only produced on the pre-spawn short-circuit,
    // proving the process was never launched (echo never produced its output).
    expect(result.result).toContain('command aborted before start');
  });
});

describe('executeNativeTool — git tools', () => {
  function gitRepo(): void {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@e.local'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  }

  it('git_diff shows working-tree changes', async () => {
    gitRepo();
    writeFileSync(join(dir, 'tracked.txt'), 'one\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
    writeFileSync(join(dir, 'tracked.txt'), 'two\n');
    const result = await executeNativeTool('git_diff', {}, ctx());
    expect(result.ok).toBe(true);
    expect(result.result).toContain('+two');
  });

  it('create_branch creates and switches to a branch', async () => {
    gitRepo();
    writeFileSync(join(dir, 'f.txt'), 'x\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
    const result = await executeNativeTool('create_branch', { name: 'excalibur/feature' }, ctx());
    expect(result.ok).toBe(true);
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
    expect(branch).toBe('excalibur/feature');
  });

  it('apply_patch applies a unified diff and refuses out-of-tree paths', async () => {
    gitRepo();
    writeFileSync(join(dir, 'base.txt'), 'a\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
    const goodDiff = ['--- a/base.txt', '+++ b/base.txt', '@@ -1 +1,2 @@', ' a', '+b', ''].join(
      '\n',
    );
    const applied = await executeNativeTool('apply_patch', { diff: goodDiff }, ctx());
    expect(applied.ok).toBe(true);
    expect(readFileSync(join(dir, 'base.txt'), 'utf8')).toBe('a\nb\n');

    // git apply (no --unsafe-paths) refuses a diff that escapes the work tree.
    const evilDiff = [
      '--- a/../../etc/evil',
      '+++ b/../../etc/evil',
      '@@ -0,0 +1 @@',
      '+pwned',
      '',
    ].join('\n');
    const rejected = await executeNativeTool('apply_patch', { diff: evilDiff }, ctx());
    expect(rejected.ok).toBe(false);
  });
});
