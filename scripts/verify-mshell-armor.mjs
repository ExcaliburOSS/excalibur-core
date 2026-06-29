#!/usr/bin/env node
/**
 * DETERMINISTIC proof of the m-shell ARMOR (RUN-FIX-20): "el shell no puede crashear
 * NUNCA bajo ningún concepto". Runs the REAL CLI under a pty (via `expect`) with the
 * MOCK provider (no model, no network), then sends the m-shell process the termination
 * signals that normally kill a process — SIGTERM, SIGHUP, SIGQUIT — and after each one
 * probes it with `kill -0` (liveness). The shell MUST still be alive every time. Only
 * an uncatchable SIGKILL ends it.
 *
 * GATED: exits 0 (SKIP) without `expect`. No Moonshot key needed.
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
  console.log('⚠ verify-mshell-armor SKIPPED — `expect` not installed.');
  process.exit(0);
}
if (!existsSync(CLI)) {
  console.error('✗ CLI not built — run `pnpm -r build` first.');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'exc-armor-'));
execFileSync('git', ['init', '-q'], { cwd: dir });
execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
mkdirSync(join(dir, '.excalibur/models'), { recursive: true });
writeFileSync(
  join(dir, '.excalibur/config.yaml'),
  'version: 1\napprovals:\n  auto: true\nautonomy:\n  default: 4\n',
);
writeFileSync(
  join(dir, '.excalibur/models/providers.yaml'),
  'providers:\n  default: mock\n  mock:\n    type: mock\n',
);

const env = {
  ...process.env,
  EXCALIBUR_ASCII: '1',
  EXCALIBUR_DEBUG_EXIT: '/tmp/exc-armor-exit.log',
};
const exp = join(tmpdir(), 'exc-armor.exp');
writeFileSync(
  exp,
  [
    `set timeout 30`,
    `spawn node ${CLI}`,
    `set pid [exp_pid]`,
    // Booted + armored (the prompt only renders once the session loop is running).
    `expect -re "(construir o arreglar|What|Describe|›)"`,
    `sleep 1`,
    `foreach sig {TERM HUP QUIT} {`,
    `  exec kill -$sig $pid`,
    `  sleep 1`,
    `  if {[catch {exec kill -0 $pid}]} { puts "ARMOR_FAIL: shell DIED on SIG$sig"; exit 7 }`,
    `  puts "ARMOR_OK: survived SIG$sig"`,
    `}`,
    // Still reading input after all three signals?
    `send "hola\\r"`,
    `sleep 2`,
    `if {[catch {exec kill -0 $pid}]} { puts "ARMOR_FAIL: died processing input"; exit 7 }`,
    `puts "ARMOR_OK: alive + reading after signals"`,
    // SIGKILL is the only escape hatch.
    `exec kill -KILL $pid`,
    `sleep 1`,
    `if {[catch {exec kill -0 $pid}]} { puts "ARMOR_OK: SIGKILL ended it" } else { puts "ARMOR_WARN: survived SIGKILL?!" }`,
    `exit 0`,
  ].join('\n'),
);

console.log(
  '\n  m-shell ARMOR — survives SIGTERM / SIGHUP / SIGQUIT (deterministic, mock provider)\n',
);
let out = '';
try {
  out = execFileSync('expect', [exp], { cwd: dir, env, timeout: 60000 }).toString();
} catch (e) {
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
}
rmSync(dir, { recursive: true, force: true });

for (const line of out.split('\n')) {
  if (/ARMOR_(OK|FAIL|WARN)/.test(line)) console.log(`  ${line.trim()}`);
}
const survivedAll =
  /survived SIGTERM/.test(out) &&
  /survived SIGHUP/.test(out) &&
  /survived SIGQUIT/.test(out) &&
  /alive \+ reading after signals/.test(out);
if (!survivedAll || /ARMOR_FAIL/.test(out)) {
  console.error('\n  ✗ FAIL — the m-shell did NOT survive a signal it must survive.');
  console.error(out.slice(-1200));
  process.exit(1);
}
console.log('\n  ✓ PASS — survived every catchable termination signal; only SIGKILL ended it.\n');
