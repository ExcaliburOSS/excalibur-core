#!/usr/bin/env node
/**
 * e2e for the m-shell↔CLI parity epic: prove that the direct-CLI management
 * commands are first-class IN THE SHELL (our primary surface) — typing
 * `/work-items list`, `/sprints list`, `/plans list`, `/status` into the
 * interactive REPL runs the IDENTICAL command `excalibur <name>` runs, NOT the
 * old "Unknown command" warning.
 *
 * These commands are pure data reads (no model call), so the smoke runs against
 * the deterministic `mock` provider — no Kimi key needed. It only needs `expect`
 * to drive the pty; SKIPs (exit 0) without it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'apps/cli/dist/main.js');

try {
  execFileSync('which', ['expect'], { stdio: 'ignore' });
} catch {
  console.log('⚠ verify-shell-parity SKIPPED — `expect` not installed.');
  process.exit(0);
}
if (!existsSync(CLI)) {
  console.error('✗ CLI not built — run `pnpm --filter @excalibur-oss/excalibur build` first.');
  process.exit(1);
}

const PROVIDERS = `providers:
  default: mock
  mock:
    type: mock
`;
const env = { ...process.env, EXCALIBUR_ASCII: '1' };
const dir = mkdtempSync(join(tmpdir(), 'exc-parity-'));

function setup() {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  // The work-items store namespaces by the repo's remote, so a remote must exist
  // (matches a real cloned project — `excalibur work-items list` requires one).
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/demo.git'], { cwd: dir });
  mkdirSync(join(dir, '.excalibur/models'), { recursive: true });
  writeFileSync(join(dir, '.excalibur/config.yaml'), 'version: 1\ncommands: {}\n');
  writeFileSync(join(dir, '.excalibur/models/providers.yaml'), PROVIDERS);
  writeFileSync(join(dir, 'README.md'), '# Demo\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
}

/**
 * Drives the REPL over a pty: send each slash command, then WAIT for its output
 * marker before sending the next (synchronizes with the live redraw — a fixed
 * sleep races the editor's repaint and drops keystrokes).
 */
function driveRepl(steps) {
  const exp = join(tmpdir(), `exc-parity-${Math.abs(steps.length * 7919) % 100000}.exp`);
  const lines = [
    'set timeout 30',
    'log_user 1',
    `spawn node ${CLI}`,
    // Accept the first-run autonomy prompt if it appears (mock may skip it).
    'expect {',
    '  -re "(automatically|automáticamente)" { send "y\\r" }',
    '  timeout {}',
    '}',
    'sleep 1',
  ];
  for (const { cmd, marker } of steps) {
    lines.push(
      `send "${cmd}\\r"`,
      `expect { -re "${marker}" {} timeout { puts "TIMEOUT:${cmd}" } }`,
    );
  }
  lines.push('send "/exit\\r"', 'expect eof');
  writeFileSync(exp, lines.join('\n'));
  try {
    return execFileSync('expect', [exp], {
      cwd: dir,
      env,
      timeout: 90_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch (err) {
    // `expect eof` can exit non-zero; the captured output still carries the proof.
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
}

const fail = (msg, out) => {
  console.error(`\n  ✗ FAIL: ${msg}`);
  if (out) console.error(`    --- captured ---\n${out.split('\n').slice(-40).join('\n')}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
};

console.log('\n  m-shell↔CLI parity e2e — management commands as slash commands (mock)\n');
setup();

const out = driveRepl([
  { cmd: '/sprints list', marker: 'No sprints yet' },
  { cmd: '/plans list', marker: 'No saved plans yet' },
  { cmd: '/status', marker: '(No local tasks yet|Patches:)' },
  { cmd: '/work-items list', marker: '(git remotes|No issues found)' },
]);

// The OLD behaviour printed "Unknown command: /sprints. Try /help." for each —
// that path no longer exists for any of these (the passthrough catches them).
if (/Unknown command/i.test(out)) {
  fail('a passthrough command still routed to the "Unknown command" warning', out);
}

// Each clean command must show ITS real output (the same text `excalibur <name>`
// prints). `work-items` is also driven (it needs a real GitHub host so it errors
// offline) — its reachability is proven by the global no-"Unknown command" check
// above: the shell ran the real command, which surfaced its OWN error.
const checks = [
  { cmd: '/sprints list', needle: /No sprints yet/i },
  { cmd: '/plans list', needle: /No saved plans yet/i },
  { cmd: '/status', needle: /No local tasks yet|Patches:/i },
];
for (const { cmd, needle } of checks) {
  if (!needle.test(out)) {
    fail(`\`${cmd}\` did not run its real command (expected ${needle})`, out);
  }
}

console.log('  ✓ /sprints list    → real sprints command (No sprints yet)');
console.log('  ✓ /plans list      → real plans command (No saved plans yet)');
console.log('  ✓ /status          → real status command (project status)');
console.log('  ✓ /work-items list → reached the real command (no "Unknown command" warning)');
console.log(
  '\n  ✓ PASS — the management commands are first-class in the shell, running the ' +
    'IDENTICAL action as `excalibur <command>`.\n',
);
rmSync(dir, { recursive: true, force: true });
