#!/usr/bin/env node
/**
 * Proof the PASSIVE `scope` terminal route is retired: a former-scope request
 * ("analiza qué implica añadir X") no longer prints the read-only scope dump
 * ("Analizando (solo lectura)" / a ScopeMap / "## Open questions"); it is answered
 * as a normal (informative) agent turn instead. Drives the m-shell over a pty.
 *
 * GATED: SKIP without a Kimi key or `expect`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
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
  console.log('⚠ verify-scope-retired SKIPPED — no Kimi/Moonshot key.');
  process.exit(0);
}
try {
  execFileSync('which', ['expect'], { stdio: 'ignore' });
} catch {
  console.log('⚠ verify-scope-retired SKIPPED — `expect` not installed.');
  process.exit(0);
}
if (!existsSync(CLI)) {
  console.error('✗ CLI not built — run `pnpm -r build` first.');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'exc-scope-'));
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
writeFileSync(
  join(dir, 'app.js'),
  "// a tiny app\nfunction main() { return 'hi'; }\nmodule.exports = { main };\n",
);
execFileSync('git', ['add', '-A'], { cwd: dir });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });

const env = { ...process.env, MOONSHOT_API_KEY: KEY, EXCALIBUR_ASCII: '1' };
const REQUEST = 'analiza que implica anadir un sistema de login a esta app';

const exp = join(tmpdir(), 'exc-scope.exp');
writeFileSync(
  exp,
  [
    `set timeout 180`,
    `log_file -a /tmp/scope-retired-full.log`,
    `spawn node ${CLI}`,
    `expect {`,
    `  -re "(automáticamente|automatically)" { send -- "y\\r"; exp_continue }`,
    `  -re "(construir o arreglar|›)" {}`,
    `  timeout {}`,
    `}`,
    `sleep 2`,
    `set landed 0`,
    `for {set i 0} {$i < 3 && !$landed} {incr i} {`,
    `  send -- "${REQUEST}\\r"`,
    `  set timeout 25`,
    `  expect { -re "login" { set landed 1 } timeout {} }`,
    `}`,
    `puts "SCOPE_LANDED: $landed"`,
    // Give the turn time to produce SOMETHING, then exit. We assert on the transcript, not a marker.
    `set timeout 120`,
    `expect {`,
    `  -re "Analizando .solo lectura|mapa de alcance|Open questions" { puts "SCOPE_DUMP: yes" }`,
    `  -re "(◇|●|Trabajando|tool |leyendo|read_file|login)" { puts "AGENT_TURN: yes" }`,
    `  timeout {}`,
    `}`,
    `sleep 20`,
    `send -- "/exit\\r"`,
    `sleep 2`,
    `exit 0`,
  ].join('\n'),
);

console.log(
  '\n  Scope retirement — "analiza qué implica X" no longer dumps a read-only scope? (Kimi)\n',
);
rmSync('/tmp/scope-retired-full.log', { force: true });
let out = '';
try {
  out = execFileSync('expect', [exp], { cwd: dir, env, timeout: 400000 }).toString();
} catch (e) {
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
}
const full = existsSync('/tmp/scope-retired-full.log')
  ? readFileSync('/tmp/scope-retired-full.log', 'utf8')
  : out;
// eslint-disable-next-line no-control-regex
const clean = full.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][0-9;]*/g, '');
for (const line of out.split('\n')) {
  if (/SCOPE_(LANDED|DUMP)|AGENT_TURN/.test(line)) console.log(`  ${line.trim()}`);
}
const dumped = /Analizando \(solo lectura\)|mapa de alcance|## Open questions/i.test(clean);
const alive = clean.includes('›') || /Trabajando|tool |read_file/i.test(clean);
console.log(`  dumped-readonly-scope: ${dumped}`);
console.log(`  agent-turn-ran-and-alive: ${alive}`);
if (!dumped && alive) {
  rmSync(dir, { recursive: true, force: true });
  console.log('\n  ✓ PASS — no read-only scope dump; handled as a normal agent turn.\n');
  process.exit(0);
}
console.error(`\n  ✗ FAIL — dumped=${dumped} alive=${alive}. Repo: ${dir}\n`);
console.error(clean.slice(-2000));
process.exit(1);
