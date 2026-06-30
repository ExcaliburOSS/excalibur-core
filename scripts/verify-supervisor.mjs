#!/usr/bin/env node
/**
 * RUN-FIX-24 proof: the supervisor makes the m-shell UNCRASHABLE. We launch the real shell
 * (mock provider — no model/key needed), inject a deterministic UNCATCHABLE crash
 * (EXCALIBUR_TEST_CRASH_MS → the child self-SIGKILLs, which no in-process guard can survive),
 * and assert the supervisor RESPAWNS it: the recovery notice prints and the shell is still
 * alive AND still reading input afterwards. Fast + deterministic (no network). Needs `expect`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'apps/cli/dist/main.js');
try {
  execFileSync('which', ['expect'], { stdio: 'ignore' });
} catch {
  console.log('⚠ verify-supervisor SKIPPED — `expect` not installed.');
  process.exit(0);
}
if (!existsSync(CLI)) {
  console.error('✗ CLI not built — run `pnpm -r build` first.');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'exc-sup-'));
execFileSync('git', ['init', '-q'], { cwd: dir });
execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
mkdirSync(join(dir, '.excalibur', 'models'), { recursive: true });
// Mock provider → zero-config, no key, deterministic. The supervisor wraps it the same way.
writeFileSync(join(dir, '.excalibur', 'config.yaml'), 'version: 1\n');

const env = {
  ...process.env,
  EXCALIBUR_ASCII: '1',
  // Crash the FIRST child ~3.5s in (after the welcome + first prompt are up).
  EXCALIBUR_TEST_CRASH_MS: '3500',
};

const exp = join(tmpdir(), 'exc-sup.exp');
writeFileSync(
  exp,
  [
    `set timeout 60`,
    `spawn node ${CLI}`,
    `set pid [exp_pid]`,
    // Wait for the first prompt so we know the child is up before it self-kills.
    `expect -re "(construir o arreglar|What|Describe|›)"`,
    // The child SIGKILLs itself at ~3.5s; the supervisor must print the recovery notice.
    `expect {`,
    `  -re "(recuper|recovered|crashed unexpectedly|se cayó)" { puts "SUP_OK: recovery notice shown" }`,
    `  timeout { puts "SUP_FAIL: no recovery notice (supervisor did not respawn)" }`,
    `}`,
    `sleep 2`,
    // The supervisor (exp_pid) must still be alive…
    `if {[catch {exec kill -0 $pid}]} { puts "SUP_FAIL: supervisor process died"; exit 7 }`,
    `puts "SUP_OK: supervisor alive after the crash"`,
    // …and the RESPAWNED shell must be reading input (prompt is back).
    `send -- "hola, sigues ahi?\\r"`,
    `sleep 3`,
    `if {[catch {exec kill -0 $pid}]} { puts "SUP_FAIL: died after respawn input"; exit 7 }`,
    `puts "SUP_OK: respawned shell alive + reading"`,
    `send -- "/exit\\r"`,
    `sleep 2`,
    `exit 0`,
  ].join('\n'),
);

console.log('\n  supervisor (RUN-FIX-24) — does the shell come back after an uncatchable kill?\n');
let out = '';
try {
  out = execFileSync('expect', [exp], { cwd: dir, env, timeout: 90_000 }).toString();
} catch (e) {
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
}
for (const line of out.split('\n')) {
  if (/SUP_(OK|FAIL)/.test(line)) console.log(`  ${line.trim()}`);
}

const recovered = /SUP_OK: recovery notice shown/.test(out);
const aliveAfter = /SUP_OK: supervisor alive after the crash/.test(out);
const reading = /SUP_OK: respawned shell alive \+ reading/.test(out);
if (!recovered || !aliveAfter || !reading || /SUP_FAIL/.test(out)) {
  console.error(`\n  ✗ FAIL — the supervisor did not recover the shell. Repo: ${dir}\n`);
  console.error(out.slice(-2000));
  process.exit(1);
}
rmSync(dir, { recursive: true, force: true });
console.log('\n  ✓ PASS — the shell self-SIGKILLed and the supervisor brought it right back.\n');
