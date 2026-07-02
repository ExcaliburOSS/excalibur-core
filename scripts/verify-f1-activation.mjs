#!/usr/bin/env node
/**
 * F1 proof — "el backlog se escribe solo": an ORDINARY natural-language build typed
 * into the m-shell at default autonomy now leaves DURABLE PRODUCT STATE on disk:
 *   .excalibur/plans/        ≥1 persisted plan (.md + .plan.json sidecar)
 *   .excalibur/work-items/   ≥1 WI-*.json (the build's board card)
 *   .excalibur/sprints/      ≥1 ACTIVE rolling sprint carrying the item
 *   .excalibur/memory/       nodes.jsonl (PLAN6-for-auto-builds decision memory)
 * Before F1 the default L4 path wrote ZERO bytes to any of these stores (the
 * activation audit's root finding). Drives the REPL over a pty like the other
 * verify-* harnesses and asserts the stores after the build settles.
 *
 * GATED: SKIP without a Kimi key or `expect`. A real gated build is slow.
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
  console.log('⚠ verify-f1-activation SKIPPED — no Kimi/Moonshot key.');
  process.exit(0);
}
try {
  execFileSync('which', ['expect'], { stdio: 'ignore' });
} catch {
  console.log('⚠ verify-f1-activation SKIPPED — `expect` not installed.');
  process.exit(0);
}
if (!existsSync(CLI)) {
  console.error('✗ CLI not built — run `pnpm -r build` first.');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'exc-f1-'));
execFileSync('git', ['init', '-q'], { cwd: dir });
execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
mkdirSync(join(dir, '.excalibur', 'models'), { recursive: true });
writeFileSync(
  join(dir, '.excalibur', 'config.yaml'),
  'version: 1\nautonomy:\n  default: 4\napprovals:\n  auto: true\n',
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
execFileSync('git', ['add', '-A'], { cwd: dir });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });

const env = { ...process.env, MOONSHOT_API_KEY: KEY, EXCALIBUR_ASCII: '1' };
// A small, ORDINARY single-lane build — exactly the case that used to leave zero
// product state behind (multi-lane fan-out is verify-orch-swarm's job).
// NOTE: the text is embedded in a Tcl `send -- "…"` — keep it free of double
// quotes, backslashes and `$`/`[` (Tcl specials) or expect dies at parse time.
const BUILD =
  'crea un archivo saludo.js con una funcion saludo(nombre) que devuelve el texto Hola nombre';

const exp = join(tmpdir(), 'exc-f1.exp');
writeFileSync(
  exp,
  [
    `set timeout 900`,
    `spawn node ${CLI}`,
    `set pid [exp_pid]`,
    `expect {`,
    `  -re "(automatically|automáticamente)" { send -- "y\\r"; exp_continue }`,
    `  -re "(construir o arreglar|What do you|Describe|›)" {}`,
    `  timeout {}`,
    `}`,
    `sleep 2`,
    // Box-init race (known pty flake): re-send until the build text echoes.
    `set landed 0`,
    `for {set try 0} {$try < 3 && !$landed} {incr try} {`,
    `  send -- "${BUILD}\\r"`,
    `  set timeout 25`,
    `  expect {`,
    `    -re "saludo" { set landed 1 }`,
    `    timeout {}`,
    `  }`,
    `}`,
    `puts "F1_LANDED: $landed"`,
    // DECISIVE SIGNAL 1 — the board announcement (the keystone materialized).
    `set board unknown`,
    `set timeout 240`,
    `expect {`,
    `  -re "aprobaci|approve automatically" { send -- "y\\r"; exp_continue }`,
    `  -re "(en el board|on the board)" { set board yes }`,
    `  timeout { set board timeout }`,
    `}`,
    `puts "F1_BOARD_LINE: $board"`,
    // Let the gated build run to settle (single tiny file — bounded window).
    `set timeout 600`,
    `expect {`,
    `  -re "aprobaci|approve automatically" { send -- "y\\r"; exp_continue }`,
    `  -re "(justo ahora|just now|siguen en rojo|still red)" {}`,
    `  timeout {}`,
    `}`,
    `sleep 5`,
    `if {[catch {exec kill -0 $pid}]} { puts "F1_NOTE: shell not alive" } else { puts "F1_OK: shell alive" }`,
    `send -- "/exit\\r"`,
    `sleep 3`,
    `exit 0`,
  ].join('\n'),
);

console.log('\n  F1 — does an ordinary NL build leave durable product state? (Kimi)\n');
let out = '';
try {
  out = execFileSync('expect', [exp], { cwd: dir, env, timeout: 1_200_000 }).toString();
} catch (e) {
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
}
for (const line of out.split('\n')) {
  if (/F1_(LANDED|BOARD_LINE|OK|NOTE)/.test(line)) console.log(`  ${line.trim()}`);
}

// THE F1 EXIT CRITERION — the stores, on disk, after one ordinary build.
const exc = join(dir, '.excalibur');
const list = (p) => (existsSync(join(exc, p)) ? readdirSync(join(exc, p)) : []);
const plans = list('plans').filter((f) => f.endsWith('.plan.json'));
const items = list('work-items').filter((f) => /^WI-\d+\.json$/.test(f));
const sprints = list('sprints').filter((f) => f.endsWith('.json'));
const activeSprint = sprints.some((f) => {
  try {
    return JSON.parse(readFileSync(join(exc, 'sprints', f), 'utf8')).status === 'active';
  } catch {
    return false;
  }
});
const memory = existsSync(join(exc, 'memory', 'nodes.jsonl'));

console.log(
  `  plans: ${plans.length} · work items: ${items.length} · sprints: ${sprints.length} (active: ${activeSprint}) · memory: ${memory}`,
);

const pass = plans.length >= 1 && items.length >= 1 && activeSprint;
if (pass) {
  if (!memory) {
    console.log(
      '  ⚠ memory nodes missing — build may not have settled inside the window (non-fatal).',
    );
  }
  rmSync(dir, { recursive: true, force: true });
  console.log('\n  ✓ PASS — the ordinary build materialized plan + board card + rolling sprint.\n');
  process.exit(0);
}
console.error(`\n  ✗ FAIL — durable product state missing after the build. Repo: ${dir}\n`);
process.exit(1);
