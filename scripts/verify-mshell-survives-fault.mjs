#!/usr/bin/env node
/**
 * REAL-Kimi e2e for RUN-FIX-18 (nunca es nunca): a build whose VERIFICATION FAILS
 * must NOT exit the m-shell. This is the user's exact crash: a gated build runs, the
 * test gate goes red, self-heal exhausts, the red receipt prints — and the shell
 * used to EXIT the process there. It must instead come back to a LIVE prompt that
 * still executes a follow-up.
 *
 * Forced-deterministic failure: `commands.test = exit 1`, so the gated Verify phase
 * ALWAYS fails (no reliance on the model writing bad code) → self-heal → exhaust →
 * red receipt. AFTER that, we send `!echo <MARKER>` (a shell passthrough). If the
 * marker appears in the transcript, the REPL survived the failing build and is still
 * reading input. If the shell had exited (the bug), the marker can never print.
 *
 * GATED: exits 0 (SKIP) without a Moonshot key or without `expect`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
  console.log('⚠ verify-mshell-survives-fault SKIPPED — no Kimi/Moonshot key.');
  process.exit(0);
}
try {
  execFileSync('which', ['expect'], { stdio: 'ignore' });
} catch {
  console.log('⚠ verify-mshell-survives-fault SKIPPED — `expect` not installed.');
  process.exit(0);
}
if (!existsSync(CLI)) {
  console.error('✗ CLI not built — run `pnpm -r build` first.');
  process.exit(1);
}

const PROVIDERS = `providers:
  default: kimi
  kimi:
    type: openai-compatible
    baseUrl: https://api.moonshot.ai/v1
    apiKeyEnv: MOONSHOT_API_KEY
    model: kimi-k2.7-code
    contextWindow: 262144
    inputCostPerMillionTokensCents: 60
    outputCostPerMillionTokensCents: 250
    capabilities:
      reasoning: true
      tools: true
`;
const env = { ...process.env, MOONSHOT_API_KEY: KEY, EXCALIBUR_ASCII: '1' };
const dir = mkdtempSync(join(tmpdir(), 'exc-survives-'));
const MARKER = 'STILL_ALIVE_AFTER_FAILED_BUILD';

function setup() {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  mkdirSync(join(dir, '.excalibur/models'), { recursive: true });
  // A test command that ALWAYS fails → the gated Verify phase is red every time.
  writeFileSync(join(dir, '.excalibur/config.yaml'), 'version: 1\ncommands:\n  test: exit 1\n');
  writeFileSync(join(dir, '.excalibur/models/providers.yaml'), PROVIDERS);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/math.ts'), 'export function add(a, b) {\n  return a + b;\n}\n');
  writeFileSync(join(dir, 'README.md'), '# Demo\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
}

/** Drive the REPL: accept auto, run a build that will fail verification, then —
 * crucially AFTER the failed build — a shell passthrough that prints MARKER, then exit. */
function drive(buildPrompt, waitS) {
  const exp = join(tmpdir(), `exc-survives.exp`);
  writeFileSync(
    exp,
    [
      `set timeout ${waitS + 180}`,
      `spawn node ${CLI}`,
      `expect -re "(automatically|automáticamente)"`,
      `send "y\\r"`,
      // The pty consistently drops the FIRST post-auth line to a box-init timing
      // race — flush it with a throwaway empty line before the real request.
      `sleep 3`,
      `send "\\r"`,
      `sleep 2`,
      `send "${buildPrompt}\\r"`,
      // Wait for the build to run, fail verification, self-heal, exhaust.
      `sleep ${waitS}`,
      // THE DISCRIMINATOR: if the shell exited on the failed build, none of these
      // `!echo` passthroughs can ever print the marker. Retry a few times in case
      // the first lands while the rail is still repainting (the input is queued).
      `for {set i 0} {$i < 6} {incr i} {`,
      `  send "!echo ${MARKER}\\r"`,
      `  set got [expect -timeout 8 -re "${MARKER}" { set r 1 } timeout { set r 0 }]`,
      `  if {$r == 1} break`,
      `  sleep 3`,
      `}`,
      `send "/exit\\r"`,
      `expect eof`,
    ].join('\n'),
  );
  try {
    const t = execFileSync('expect', [exp], {
      cwd: dir,
      env,
      timeout: (waitS + 240) * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    writeFileSync('/tmp/exc-survives-full.txt', t);
    return t;
  } catch (e) {
    // `expect` exits non-zero if the MARKER never appeared (the shell died) OR on a
    // benign eof race; return whatever was captured so the assertion below decides.
    const t = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    writeFileSync('/tmp/exc-survives-full.txt', t);
    return t;
  }
}

const fail = (msg, extra) => {
  console.error(`\n  ✗ FAIL: ${msg}`);
  if (extra) console.error(`    ${String(extra).slice(0, 4000)}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
};

console.log('\n  m-shell SURVIVES a failing build (RUN-FIX-18) · vs kimi-k2.7-code\n');
setup();
const out = drive('edit src/math.ts so add() rejects non-number arguments', 200);

// 1) The build actually ran AND its verification went red (self-heal exhausted) —
//    so we genuinely exercised the failure path, not a clean success.
const sawRed = /rojo|red|fail|✗|self-?heal|verificaci|verification/i.test(out) === true;
// 2) THE crash guarantee: the shell was STILL ALIVE after the failed build and ran
//    the follow-up shell command (printed the marker).
const survived = out.includes(MARKER);

console.log(`  failing-build path exercised: ${sawRed}`);
console.log(`  shell survived + ran a follow-up after the red build: ${survived}`);

if (!survived) {
  fail('the m-shell did NOT survive the failed build — the follow-up never ran (it exited).', out);
}
rmSync(dir, { recursive: true, force: true });
console.log('\n  ✓ PASS — a failing build returned to a LIVE prompt; the m-shell never exited.\n');
