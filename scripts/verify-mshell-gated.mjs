#!/usr/bin/env node
/**
 * REAL-Kimi e2e for RUN-FIX-10: prove that a BUILD typed into the interactive
 * m-shell (the `excalibur` REPL) now runs the GATED workflow engine — the SAME
 * one `excalibur run` uses — not a bare single agent loop.
 *
 * Discriminator: a bare conversational turn synthesizes exactly ONE phase (named by
 * the role gerund, e.g. "Working on your task…"). The gated workflow streams the
 * complexity-sized phases (Plan/Implement/Verify/Review/…) AND emits verification /
 * claim gate events. We drive the REPL over a pty with `expect`, then read the
 * resulting run's events.jsonl and assert the gated signature.
 *
 * GATED: exits 0 (SKIP) without a Moonshot key or without `expect`.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
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
  console.log('⚠ verify-mshell-gated SKIPPED — no Kimi/Moonshot key.');
  process.exit(0);
}
try {
  execFileSync('which', ['expect'], { stdio: 'ignore' });
} catch {
  console.log('⚠ verify-mshell-gated SKIPPED — `expect` not installed.');
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
    # Match real onboarding: kimi is a REASONING model, so the intent router gives
    # the classifier a generous budget (256 tok) instead of the 6-tok fast-model cap
    # that would burn out thinking → empty → everything mis-routed to "chat".
    capabilities:
      reasoning: true
      tools: true
`;
const env = { ...process.env, MOONSHOT_API_KEY: KEY, EXCALIBUR_ASCII: '1' };
const dir = mkdtempSync(join(tmpdir(), 'exc-mshell-'));

function setup() {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  mkdirSync(join(dir, '.excalibur/models'), { recursive: true });
  writeFileSync(join(dir, '.excalibur/config.yaml'), 'version: 1\ncommands: {}\n');
  writeFileSync(join(dir, '.excalibur/models/providers.yaml'), PROVIDERS);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/math.ts'), 'export function add(a, b) {\n  return a + b;\n}\n');
  writeFileSync(join(dir, 'README.md'), '# Demo\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
}

/** Drives the REPL over a pty: auto-accept, send one build task, wait, exit. */
function replTurn(prompt, waitS) {
  const exp = join(tmpdir(), `exc-mshell-${Math.abs(prompt.length * 7919) % 100000}.exp`);
  writeFileSync(
    exp,
    [
      `set timeout ${waitS + 60}`,
      `spawn node ${CLI}`,
      `expect -re "(automatically|automáticamente)"`,
      `send "y\\r"`,
      `sleep 2`,
      `send "${prompt}\\r"`,
      `sleep ${waitS}`,
      `send "/exit\\r"`,
      `expect eof`,
    ].join('\n'),
  );
  try {
    execFileSync('expect', [exp], {
      cwd: dir,
      env,
      timeout: (waitS + 90) * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    /* expect eof can exit non-zero; the assertions check the real outcome */
  }
}

function latestRunEvents() {
  const runsDir = join(dir, '.excalibur/runs');
  if (!existsSync(runsDir)) return [];
  const ids = readdirSync(runsDir).sort();
  if (ids.length === 0) return [];
  const f = join(runsDir, ids[ids.length - 1], 'events.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const fail = (msg, extra) => {
  console.error(`\n  ✗ FAIL: ${msg}`);
  if (extra) console.error(`    ${extra}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
};

console.log('\n  m-shell gated-workflow e2e (RUN-FIX-10) · vs kimi-k2.7-code\n');
setup();
// A single-workstream build → dispatchAutoBuild's fallback → the GATED engine.
replTurn('add argument validation to add() in src/math.ts so it rejects non-numbers', 200);

const events = latestRunEvents();
if (events.length === 0) fail('no run was recorded from the m-shell turn');

const phaseNames = events
  .filter((e) => e.type === 'phase_started')
  .map((e) => String(e.payload?.name ?? ''));
const distinct = [...new Set(phaseNames)];
const hasGate = events.some(
  (e) => e.type === 'verification' || e.type === 'claim' || e.type === 'command_completed',
);
const types = [...new Set(events.map((e) => e.type))];

console.log(`  run phases (${distinct.length}): ${distinct.join(' · ') || '(none)'}`);
console.log(`  gate event present: ${hasGate}`);
console.log(`  event types: ${types.join(', ')}`);

// A bare conversational turn = exactly ONE synthesized phase (the gerund) and no
// verification/claim gate. The gated workflow = multiple named phases + a gate.
if (distinct.length < 2) {
  fail(
    'the m-shell build ran a single-phase bare loop — the gated workflow did NOT run',
    `phases=${JSON.stringify(distinct)}`,
  );
}
if (!hasGate) {
  fail('no verification / claim / command gate event — the gated engine did not run its gates');
}

console.log(
  `\n  ✓ PASS — the m-shell build ran the GATED workflow: ${distinct.length} phases + gate events ` +
    `(same engine as \`excalibur run\`), not a bare single loop.\n`,
);
rmSync(dir, { recursive: true, force: true });
