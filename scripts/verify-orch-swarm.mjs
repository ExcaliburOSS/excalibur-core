#!/usr/bin/env node
/**
 * ORCH1 proof: a clearly MULTI-FILE task typed into the m-shell at default autonomy now fans
 * OUT into a parallel SWARM (read-only scope grounds the split → ≥2 independent lanes),
 * instead of a single sequential agent. Drives the REPL over a pty and asserts the
 * "parallel swarm" auto-orchestration line (not "single workstream").
 *
 * GATED: SKIP without a Kimi key or `expect`. A real swarm (parallel worktree agents) is slow.
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
  console.log('⚠ verify-orch-swarm SKIPPED — no Kimi/Moonshot key.');
  process.exit(0);
}
try {
  execFileSync('which', ['expect'], { stdio: 'ignore' });
} catch {
  console.log('⚠ verify-orch-swarm SKIPPED — `expect` not installed.');
  process.exit(0);
}
if (!existsSync(CLI)) {
  console.error('✗ CLI not built — run `pnpm -r build` first.');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'exc-orch-'));
execFileSync('git', ['init', '-q'], { cwd: dir });
execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
mkdirSync(join(dir, '.excalibur', 'models'), { recursive: true });
// Full Agentic (4) + auto-approve ON — the unattended full-autonomy user this feature targets.
// (With approvals.auto:false a fresh L4 build first asks "¿…automáticamente? [Y/n]", which a
// non-interactive harness can't answer → it would deadlock waiting for the announcement.)
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
// Three clearly-INDEPENDENT files → the decomposition should split into ≥2 parallel lanes.
const BUILD =
  'crea tres archivos JS independientes, cada uno en su propio fichero: header.js con una funcion que ' +
  'devuelve el HTML de una cabecera, footer.js con una funcion que devuelve el HTML de un pie, y ' +
  'math.js con una funcion suma(a,b). Son independientes entre si.';

const exp = join(tmpdir(), 'exc-orch.exp');
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
    // Box-init race (known pty flake, see 1.8.5 notes): the FIRST post-prompt keystrokes
    // can be swallowed before the input box arms. Send the build, confirm it ECHOED
    // (the word "math" — unique to the build text, NOT in the swarm announcement, so it
    // can't accidentally consume the announcement), and re-send up to twice if lost.
    `set landed 0`,
    `for {set try 0} {$try < 3 && !$landed} {incr try} {`,
    `  send -- "${BUILD}\\r"`,
    `  set timeout 25`,
    `  expect {`,
    `    -re "math" { set landed 1 }`,
    `    timeout {}`,
    `  }`,
    `}`,
    `puts "ORCH_LANDED: $landed"`,
    // The DECISIVE signal: the auto-orchestrator announces a PARALLEL SWARM (≥2 lanes), not a
    // single workstream. Match either language. Bounded window (scope caps at 45s + decompose).
    `set result unknown`,
    `set timeout 300`,
    `expect {`,
    // Belt-and-suspenders: auto-answer any stray approval prompt (e.g. "¿…aprobación? [Y/n]")
    // so a confirm can never deadlock the wait for the announcement.
    `  -re "aprobaci|approve automatically" { send -- "y\\r"; exp_continue }`,
    `  -re "(swarm en paralelo|parallel swarm|flujos de trabajo independientes|independent workstreams)" { set result swarm }`,
    `  -re "(un solo flujo de trabajo|a single workstream)" { set result sequential }`,
    `  timeout { set result timeout }`,
    `}`,
    `puts "ORCH_RESULT: $result"`,
    // Let it run a bit so the shell survives too (regression guard for RUN-FIX-25).
    `sleep 30`,
    `if {[catch {exec kill -0 $pid}]} { puts "ORCH_NOTE: shell not alive after fan-out" } else { puts "ORCH_OK: shell alive" }`,
    `send -- "/exit\\r"`,
    `sleep 3`,
    `exit 0`,
  ].join('\n'),
);

console.log('\n  ORCH1 — does a multi-file task fan out into a parallel swarm? (Kimi)\n');
let out = '';
try {
  out = execFileSync('expect', [exp], { cwd: dir, env, timeout: 1000000 }).toString();
} catch (e) {
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
}
for (const line of out.split('\n')) {
  if (/ORCH_(RESULT|OK|NOTE)/.test(line)) console.log(`  ${line.trim()}`);
}
if (/ORCH_RESULT: swarm/.test(out)) {
  rmSync(dir, { recursive: true, force: true });
  console.log('\n  ✓ PASS — the multi-file task fanned out into a PARALLEL SWARM.\n');
  process.exit(0);
}
console.error(`\n  ✗ FAIL — no parallel swarm was announced. Repo: ${dir}\n`);
console.error(out.slice(-2000));
process.exit(1);
