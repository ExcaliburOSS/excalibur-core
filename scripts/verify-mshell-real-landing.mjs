#!/usr/bin/env node
/**
 * REAL end-to-end proof (Kimi) that the m-shell SURVIVES a full landing-page build —
 * the exact scenario the user kept crashing on ("al arrancar el servidor web"). Drives a
 * real conversational BUILD (writes html/css + a node server) over a pty (via `expect`),
 * waits for the whole turn (+ any self-heal) to settle, then probes that the shell is
 * STILL ALIVE and STILL READING input. EXCALIBUR_DEBUG_EXIT captures the exact cause if it
 * ever does die — the smoking gun.
 *
 * GATED: SKIP without a Kimi key (~/.config/excalibur/moonshot.key or MOONSHOT_API_KEY) or
 * without `expect`. Slow (a real build is minutes) — run it on demand, not in CI.
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
  console.log('⚠ verify-mshell-real-landing SKIPPED — no Kimi/Moonshot key.');
  process.exit(0);
}
try {
  execFileSync('which', ['expect'], { stdio: 'ignore' });
} catch {
  console.log('⚠ verify-mshell-real-landing SKIPPED — `expect` not installed.');
  process.exit(0);
}
if (!existsSync(CLI)) {
  console.error('✗ CLI not built — run `pnpm -r build` first.');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'exc-landing-'));
execFileSync('git', ['init', '-q'], { cwd: dir });
execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
mkdirSync(join(dir, '.excalibur', 'models'), { recursive: true });
writeFileSync(
  join(dir, '.excalibur', 'config.yaml'),
  'version: 1\napprovals:\n  auto: true\nautonomy:\n  default: 4\n',
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

const BUILD =
  'crea una landing page sencilla: public/index.html con un titulo y un parrafo, ' +
  'public/styles.css con estilos basicos, y un server.js minimal en node que sirva public/ ' +
  'en el puerto 3000. Arranca el servidor para previsualizarla.';

const exp = join(tmpdir(), 'exc-landing.exp');
writeFileSync(
  exp,
  [
    `set timeout 900`,
    `spawn node ${CLI}`,
    `set pid [exp_pid]`,
    `expect -re "(construir o arreglar|What|Describe|›)"`,
    `sleep 1`,
    `send -- "${BUILD}\\r"`,
    // Wait (up to the 900s timeout) for the turn to SETTLE — match a post-build signal:
    // the warm receipt / self-heal / the autonomy footer / the orchestration hint. Any of
    // them means we're past the build and back near the prompt.
    `expect {`,
    `  -re "(justo ahora|hace un|tokens|Lo intent|self-heal|◆ Level|done|orquestaci|orchestrat|verificaciones)" {}`,
    `  timeout { puts "LANDING_NOTE: no settle marker within timeout (build may be long)" }`,
    `}`,
    // Give the post-turn settle + any second self-heal pass time to fully land.
    `sleep 20`,
    // THE CRUX: is the shell STILL ALIVE after the whole build settled?
    `if {[catch {exec kill -0 $pid}]} { puts "LANDING_FAIL: shell DIED at end of build"; exit 7 }`,
    `puts "LANDING_OK: alive after the build settled"`,
    // …and STILL READING input (the prompt came back, not a zombie)?
    `send -- "hola, sigues ahi?\\r"`,
    `sleep 8`,
    `if {[catch {exec kill -0 $pid}]} { puts "LANDING_FAIL: died on post-build input"; exit 7 }`,
    `puts "LANDING_OK: alive + reading after the build"`,
    `send -- "/exit\\r"`,
    `sleep 3`,
    `exit 0`,
  ].join('\n'),
);

console.log('\n  m-shell REAL landing build (Kimi) — survives to the end?\n');
let out = '';
try {
  out = execFileSync('expect', [exp], { cwd: dir, env, timeout: 1000000 }).toString();
} catch (e) {
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
}
const forensics = existsSync(EXIT_LOG) ? readFileSync(EXIT_LOG, 'utf8') : '';

for (const line of out.split('\n')) {
  if (/LANDING_(OK|FAIL|NOTE)/.test(line)) console.log(`  ${line.trim()}`);
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

// Keep the temp dir around on FAILURE for inspection; clean on success.
const alive =
  /alive after the build settled/.test(out) && /alive \+ reading after the build/.test(out);
if (!alive || /LANDING_FAIL/.test(out)) {
  console.error(`\n  ✗ FAIL — the m-shell did NOT survive the landing build. Repo: ${dir}\n`);
  console.error(out.slice(-2500));
  process.exit(1);
}
rmSync(dir, { recursive: true, force: true });
console.log('\n  ✓ PASS — built a real landing and the m-shell stayed alive + reading.\n');
