#!/usr/bin/env node
/**
 * F4 prerequisite — THE LAUNCH CLAIM, adversarially: "kill the terminal mid-build,
 * reopen, and the work resumes at the exact step". Each iteration:
 *
 *   1. clean repo + Kimi config → m-shell → a multi-file NL build
 *   2. wait until the plan is ON THE BOARD (F1 materialization) and lanes are in
 *      flight, then SIGKILL the WHOLE process group (uncatchable — terminal death)
 *   3. assert the durable state on disk: plan `approved`, unfinished steps, cards
 *   4. relaunch the shell in the same repo → decline the session-resume offer →
 *      ACCEPT the plan-resume offer (PLAN3) → let it run ~60s
 *   5. assert the sidecar CHANGED (a step advanced / a runId was stamped): the
 *      work genuinely continued, not just re-offered
 *
 * PASS requires N/N (default 10 — `KILL_RESUME_N` overrides). Failed iterations
 * keep their repo dir for forensics. GATED: SKIP without a Kimi key or `expect`.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'apps/cli/dist/main.js');
const KEY_FILE = join(homedir(), '.config/excalibur/moonshot.key');
const KEY =
  process.env.MOONSHOT_API_KEY ??
  (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8').trim() : '');
if (KEY.length === 0) {
  console.log('⚠ verify-kill-resume SKIPPED — no Kimi/Moonshot key.');
  process.exit(0);
}
try {
  execFileSync('which', ['expect'], { stdio: 'ignore' });
} catch {
  console.log('⚠ verify-kill-resume SKIPPED — `expect` not installed.');
  process.exit(0);
}
if (!existsSync(CLI)) {
  console.error('✗ CLI not built — run `pnpm -r build` first.');
  process.exit(1);
}

const N = Math.max(1, Number(process.env.KILL_RESUME_N ?? 10));
const env = {
  ...process.env,
  MOONSHOT_API_KEY: KEY,
  EXCALIBUR_ASCII: '1',
  EXCALIBUR_DASHBOARD: 'off',
};

// The proven-swarming phrasing (verified to fan out into a parallel swarm): three
// explicitly-independent files, named. A more elaborate wording gets classified as
// a conversational/mission turn (which doesn't materialize the board) — the launch
// DEMO uses exactly this shape. (Tcl `send` string: no double quotes / $ / [ ].)
const BUILD =
  'crea tres archivos JS independientes: header.js con una funcion que devuelve el html de una ' +
  'cabecera, footer.js con una funcion que devuelve el html de un pie, y math.js con una funcion ' +
  'suma de dos numeros. Son independientes entre si.';

function bootstrapRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'exc-kr-'));
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
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

/** Runs an expect script in `dir`; returns captured output (never throws). */
function runExpect(script, dir, timeoutMs) {
  const file = join(tmpdir(), `exc-kr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.exp`);
  writeFileSync(file, script);
  try {
    return execFileSync('expect', [file], { cwd: dir, env, timeout: timeoutMs }).toString();
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  } finally {
    rmSync(file, { force: true });
  }
}

const PHASE_A = [
  `set timeout 240`,
  `spawn node ${CLI}`,
  `set pid [exp_pid]`,
  `expect {`,
  `  -re "(automatically|automáticamente)" { send -- "y\\r"; exp_continue }`,
  `  -re "(construir o arreglar|What do you|›)" {}`,
  `  timeout {}`,
  `}`,
  `sleep 2`,
  // ONE send (no retry loop — a retry into a closed spawn is the Tcl crash we hit;
  // a rare box-init drop just fails this iteration, which the 10x retries absorb).
  `send -- "${BUILD}\\r"`,
  `set landed 0`,
  `set timeout 30`,
  `expect { -re "suma de dos numeros" { set landed 1 } timeout {} }`,
  `puts "KR_LANDED: $landed"`,
  // The DECISIVE moment: the board is materialized (plan steps marked active) the
  // instant the build is announced on the board — BEFORE the lanes finish.
  `set timeout 240`,
  `set board unknown`,
  `expect {`,
  `  -re "(en el board|on the board)" { set board yes }`,
  `  timeout { set board timeout }`,
  `}`,
  `puts "KR_BOARD: $board"`,
  // Kill ~1.5s after materialization — steps are still active, the lanes have NOT
  // settled. SIGKILL the whole group: the uncatchable terminal death.
  `sleep 1`,
  `catch { exec kill -9 -$pid }`,
  `catch { exec kill -9 $pid }`,
  `puts "KR_KILLED"`,
  `sleep 1`,
  `exit 0`,
].join('\n');

const PHASE_B = [
  `set timeout 90`,
  `spawn node ${CLI}`,
  `expect {`,
  `  -re "(Retomar tu última sesión|Resume your last session)" { send -- "n\\r"; exp_continue }`,
  `  -re "(automatically|automáticamente)" { send -- "y\\r"; exp_continue }`,
  `  -re "(plan sin terminar|unfinished plan)" { send -- "y\\r" }`,
  `  timeout { puts "KR_OFFER: timeout"; exit 0 }`,
  `}`,
  `puts "KR_OFFER: accepted"`,
  // Give the resumed execution a real window, then tear down hard (the disk
  // assert below is the evidence, not this pty).
  `sleep 75`,
  `set pid [exp_pid]`,
  `catch { exec kill -9 -$pid }`,
  `catch { exec kill -9 $pid }`,
  `exit 0`,
].join('\n');

function planSidecar(dir) {
  const plans = join(dir, '.excalibur', 'plans');
  if (!existsSync(plans)) return null;
  const file = readdirSync(plans).find((f) => f.endsWith('.plan.json'));
  if (file === undefined) return null;
  try {
    return { file, json: readFileSync(join(plans, file), 'utf8') };
  } catch {
    return null;
  }
}

function planStatus(dir) {
  const plans = join(dir, '.excalibur', 'plans');
  if (!existsSync(plans)) return null;
  const md = readdirSync(plans).find((f) => f.endsWith('.md'));
  if (md === undefined) return null;
  const front = readFileSync(join(plans, md), 'utf8').slice(0, 400);
  const m = /status: (\w+)/.exec(front);
  return m?.[1] ?? null;
}

console.log(`\n  KILL-AND-RESUME — the launch claim, ${N} adversarial iterations (Kimi)\n`);
let passed = 0;
for (let i = 1; i <= N; i++) {
  const dir = bootstrapRepo();
  const a = runExpect(PHASE_A, dir, 600_000);
  const landed = /KR_LANDED: 1/.test(a);
  const boarded = /KR_BOARD: yes/.test(a);

  // Durable state after the kill: an approved plan with unfinished steps + cards.
  const before = planSidecar(dir);
  const status = planStatus(dir);
  const items = existsSync(join(dir, '.excalibur', 'work-items'))
    ? readdirSync(join(dir, '.excalibur', 'work-items')).filter((f) => /^WI-\d+\.json$/.test(f))
        .length
    : 0;
  const unfinished = before !== null && /"status":\s*"(pending|active|blocked)"/.test(before.json);
  const stateOk = boarded && status === 'approved' && unfinished && items >= 1;

  let resumedOk = false;
  if (stateOk) {
    const b = runExpect(PHASE_B, dir, 200_000);
    const offered = /KR_OFFER: accepted/.test(b);
    const after = planSidecar(dir);
    // Execution CONTINUED: the sidecar changed (a runId stamped / a status moved).
    resumedOk = offered && after !== null && before !== null && after.json !== before.json;
  }

  const ok = landed && stateOk && resumedOk;
  console.log(
    `  #${String(i).padStart(2)} ${ok ? '✓' : '✗'}  landed:${landed} board:${boarded} ` +
      `status:${status} unfinished:${unfinished} items:${items} resumed:${resumedOk}`,
  );
  if (ok) {
    passed += 1;
    rmSync(dir, { recursive: true, force: true });
  } else {
    console.log(`      forensics: ${dir}`);
  }
}

console.log(`\n  ${passed}/${N} iterations passed`);
if (passed === N) {
  console.log('  ✓ PASS — the session died; the product never did.\n');
  process.exit(0);
}
console.error('  ✗ FAIL — the launch claim does not survive adversarial QA yet.\n');
process.exit(1);
