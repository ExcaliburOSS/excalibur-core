#!/usr/bin/env node
/**
 * RUN-FIX-25 regression: a GATED conversational build (approvals NOT auto → per-edit y/N
 * confirms read by the Ink rail, then the receipt) must leave the m-shell ALIVE and READING —
 * it must NEVER exit on its own. The old bug: on the Ink-approval → raw-editor stdin handoff
 * after the build, a spurious EOF made editor.question() return null, the REPL treated it as
 * genuine Ctrl-D and broke the loop → return 0 → the supervisor (clean exit) also exited →
 * back to zsh, silently. The auto-apply harness never hit this (no Ink approval reads).
 *
 * Drives a real gated build over a pty, answers approvals with `y`, then — WITHOUT /exit —
 * probes that the shell still reads input. Captures EXCALIBUR_DEBUG_EXIT forensics.
 *
 * GATED: SKIP without a Kimi key or `expect`. Real build → minutes.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'apps/cli/dist/main.js');
const KEY_FILE = join(homedir(), '.config/excalibur/moonshot.key');
const KEY =
  process.env.MOONSHOT_API_KEY ??
  (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8').trim() : '');
if (KEY.length === 0) {
  console.log('⚠ verify-mshell-gated-survives SKIPPED — no Kimi/Moonshot key.');
  process.exit(0);
}
try {
  execFileSync('which', ['expect'], { stdio: 'ignore' });
} catch {
  console.log('⚠ verify-mshell-gated-survives SKIPPED — `expect` not installed.');
  process.exit(0);
}
if (!existsSync(CLI)) {
  console.error('✗ CLI not built — run `pnpm -r build` first.');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'exc-gsurv-'));
execFileSync('git', ['init', '-q'], { cwd: dir });
execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
mkdirSync(join(dir, '.excalibur', 'models'), { recursive: true });
// GATED: NO `approvals.auto` → the build reads per-edit y/N through the Ink rail (the exact
// stdin path that produced the spurious post-build EOF), plus a staged-looking receipt.
writeFileSync(
  join(dir, '.excalibur', 'config.yaml'),
  'version: 1\napprovals:\n  auto: false\nautonomy:\n  default: 2\n',
);
writeFileSync(
  join(dir, '.excalibur', 'models', 'providers.yaml'),
  [
    'providers:',
    '  default: kimi',
    '  kimi:',
    '    type: openai-compatible',
    '    baseUrl: https://api.moonshot.ai/v1',
    '    apiKeyEnv: MOONSHOT_API_KEY',
    '    model: kimi-k2.7-code',
    '    contextWindow: 262144',
    '    capabilities:',
    '      reasoning: true',
    '      tools: true',
    '',
  ].join('\n'),
);

const EXIT_LOG = join(dir, 'exit-forensics.log');
const env = {
  ...process.env,
  MOONSHOT_API_KEY: KEY,
  EXCALIBUR_ASCII: '1',
  EXCALIBUR_DEBUG_EXIT: EXIT_LOG,
};
// NO double quotes inside — the expect `send -- "...\r"` would break on them.
const BUILD =
  'crea index.html con un titulo de bienvenida y styles.css con un body con fondo gris. Nada mas.';

const exp = join(tmpdir(), 'exc-gsurv.exp');
writeFileSync(
  exp,
  [
    `set timeout 900`,
    `spawn node ${CLI}`,
    `set pid [exp_pid]`,
    // Accept the first run/plan/onboarding prompt if any, then send the build.
    `expect {`,
    `  -re "(automatically|automáticamente)" { send -- "y\\r"; exp_continue }`,
    `  -re "(construir o arreglar|What do you|Describe|›)" {}`,
    `  timeout {}`,
    `}`,
    `sleep 1`,
    `send -- "${BUILD}\\r"`,
    // Answer every per-edit approval with 'y' until the turn settles (the receipt / a marker).
    `set settled 0`,
    `while {$settled == 0} {`,
    `  expect {`,
    `    -re "\\[Y/n\\]|\\[y/N\\]|aprueb|approve" { send -- "y\\r" }`,
    `    -re "(revisa con|/changes|already applied|ya están aplicados|justo ahora|tokens|tests passed|◆ Level)" { set settled 1 }`,
    `    timeout { set settled 1 }`,
    `  }`,
    `}`,
    // Give the post-turn settle + receipt + the editor re-arm time to land.
    `sleep 20`,
    // THE CRUX: the shell must be ALIVE and still READING — WITHOUT an explicit /exit.
    `if {[catch {exec kill -0 $pid}]} { catch {wait} ws; puts "GSURV_FAIL: shell EXITED on its own after the gated build"; puts "WAITSTATUS: $ws"; exit 7 }`,
    `puts "GSURV_OK: alive after the gated build"`,
    `send -- "sigues ahi? responde en una linea\\r"`,
    `sleep 12`,
    `if {[catch {exec kill -0 $pid}]} { catch {wait} ws; puts "GSURV_FAIL: died on the post-build message"; puts "WAITSTATUS: $ws"; exit 7 }`,
    `puts "GSURV_OK: alive + reading after the gated build"`,
    `send -- "/exit\\r"`,
    `sleep 3`,
    `exit 0`,
  ].join('\n'),
);

console.log('\n  m-shell GATED build survival (Kimi) — does the shell stay alive after it?\n');
let out = '';
try {
  out = execFileSync('expect', [exp], { cwd: dir, env, timeout: 1000000 }).toString();
} catch (e) {
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
}
const forensics = existsSync(EXIT_LOG) ? readFileSync(EXIT_LOG, 'utf8') : '';
for (const line of out.split('\n')) {
  if (/GSURV_(OK|FAIL)|WAITSTATUS/.test(line)) console.log(`  ${line.trim()}`);
}
if (forensics.length > 0) {
  console.log('\n  ⚑ EXIT FORENSICS:\n');
  console.log(
    forensics
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n'),
  );
}
const alive =
  /alive after the gated build/.test(out) && /alive \+ reading after the gated build/.test(out);
if (!alive || /GSURV_FAIL/.test(out)) {
  console.error(`\n  ✗ FAIL — the m-shell did NOT survive a gated build. Repo: ${dir}\n`);
  console.error(out.slice(-2500));
  process.exit(1);
}
rmSync(dir, { recursive: true, force: true });
console.log(
  '\n  ✓ PASS — the m-shell stayed alive + reading after a gated build (never exits on its own).\n',
);
