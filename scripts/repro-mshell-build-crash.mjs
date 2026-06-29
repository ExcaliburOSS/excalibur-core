#!/usr/bin/env node
/**
 * DETERMINISTIC repro of "the m-shell crashes at the END of a conversational build,
 * 100% of the time" (user, 2026-06-29). Drives a REAL conversational BUILD typed into
 * the interactive m-shell over a pty (via `expect`) with the MOCK provider (no network),
 * lets the build run to completion, then probes the process with `kill -0` (liveness)
 * AND sends a follow-up line to confirm the prompt still reads. The shell MUST stay alive.
 *
 * EXCALIBUR_DEBUG_EXIT captures the exact termination cause+stack if it DOES die — the
 * smoking gun for the deterministic teardown crash.
 *
 * GATED: exits 0 (SKIP) without `expect`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'apps/cli/dist/main.js');
try {
  execFileSync('which', ['expect'], { stdio: 'ignore' });
} catch {
  console.log('⚠ repro-mshell-build-crash SKIPPED — `expect` not installed.');
  process.exit(0);
}
if (!existsSync(CLI)) {
  console.error('✗ CLI not built — run `pnpm -r build` first.');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'exc-buildcrash-'));
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
// A package.json whose `test` ALWAYS fails — so the gated build's Verify phase goes
// red and PROACTIVE SELF-HEAL (RUN-FIX-14) kicks in: the build runTask is followed by
// up to 2 MORE runTask repair runs, i.e. the rail is mounted→unmounted→stdin-handed-back
// THREE times in one logical turn. That repeated suspend/resume handoff is the suspected
// trigger for editor.question()→null→break→exit at the end of the build.
writeFileSync(
  join(dir, 'package.json'),
  JSON.stringify({ name: 'landing', scripts: { test: 'exit 1' } }, null, 2),
);
execFileSync('git', ['add', '-A'], { cwd: dir });
execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });

const EXIT_LOG = join(dir, 'exit-forensics.log');
const env = {
  ...process.env,
  EXCALIBUR_ASCII: '1',
  EXCALIBUR_DEBUG_EXIT: EXIT_LOG,
};
const exp = join(tmpdir(), 'exc-buildcrash.exp');
writeFileSync(
  exp,
  [
    `set timeout 90`,
    `spawn node ${CLI}`,
    `set pid [exp_pid]`,
    // Wait for the welcome + the idle prompt to render.
    `expect -re "(construir o arreglar|What|Describe|›)"`,
    `sleep 1`,
    // Type a BUILD request — routes to the gated conversational build (writes files, verifies).
    `send "crea una landing page simple en public/index.html con un titulo y un parrafo\\r"`,
    // Let the whole gated build run (plan → implement → verify → review) + the TWO
    // self-heal repair runs (verify stays red) + teardown. Three rail handoffs.
    `sleep 45`,
    // The crux: is the shell STILL ALIVE after the build settled?
    `if {[catch {exec kill -0 $pid}]} { puts "BUILD_FAIL: shell DIED at end of build"; exit 7 }`,
    `puts "BUILD_OK: alive after build settled"`,
    // …and still reading input (the prompt came back, not a dead process)?
    `send "hola\\r"`,
    `sleep 3`,
    `if {[catch {exec kill -0 $pid}]} { puts "BUILD_FAIL: died processing post-build input"; exit 7 }`,
    `puts "BUILD_OK: alive + reading after build"`,
    // Clean exit via the real command so teardown runs normally.
    `send "/exit\\r"`,
    `sleep 2`,
    `exit 0`,
  ].join('\n'),
);

console.log('\n  m-shell BUILD-CRASH repro — full mock build → liveness probe\n');
let out = '';
try {
  out = execFileSync('expect', [exp], { cwd: dir, env, timeout: 120000 }).toString();
} catch (e) {
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
}

const forensics = existsSync(EXIT_LOG) ? readFileSync(EXIT_LOG, 'utf8') : '';
rmSync(dir, { recursive: true, force: true });

for (const line of out.split('\n')) {
  if (/BUILD_(OK|FAIL)/.test(line)) console.log(`  ${line.trim()}`);
}
const alive = /alive after build settled/.test(out) && /alive \+ reading after build/.test(out);
if (forensics.length > 0) {
  console.log('\n  ⚑ EXIT FORENSICS (the shell terminated):\n');
  console.log(
    forensics
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n'),
  );
}
if (!alive || /BUILD_FAIL/.test(out)) {
  console.error('\n  ✗ REPRODUCED — the m-shell did NOT survive to the end of the build.\n');
  console.error(out.slice(-2000));
  process.exit(1);
}
console.log('\n  ✓ survived the full build + still reading input.\n');
