#!/usr/bin/env node
/**
 * THE COVERAGE GUARANTEE — the fix for "most requests generate no work items".
 *
 * Materialization used to live in ONE build path (`dispatchAutoBuild`); tasks the
 * intent router sent to a conversational turn, a mission or the direct gated build
 * wrote files and left the board EMPTY. The universal safety net boards ANY turn
 * that mutated the repo, whatever path it took.
 *
 * This drives the m-shell over a pty with a VARIETY of phrasings (short, long,
 * elaborate, Spanish, "build me / implement / add" wordings) — the exact variance
 * that made classification noisy — and asserts EVERY mutating turn left ≥1 work
 * item + a plan + an active sprint. A pure QUESTION must board nothing (the
 * honest line). PASS requires 100% coverage of the mutating turns.
 *
 * GATED: SKIP without a Kimi key or `expect`.
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
  console.log('⚠ verify-materialization-coverage SKIPPED — no Kimi/Moonshot key.');
  process.exit(0);
}
try {
  execFileSync('which', ['expect'], { stdio: 'ignore' });
} catch {
  console.log('⚠ verify-materialization-coverage SKIPPED — `expect` not installed.');
  process.exit(0);
}
if (!existsSync(CLI)) {
  console.error('✗ CLI not built — run `pnpm -r build` first.');
  process.exit(1);
}

const env = {
  ...process.env,
  MOONSHOT_API_KEY: KEY,
  EXCALIBUR_ASCII: '1',
  EXCALIBUR_DASHBOARD: 'off',
};

// Deliberately-varied phrasings — the ones that used to scatter across chat /
// mission / edit / swarm. `mutates:false` is a pure question (must board NOTHING).
// (Tcl `send` strings: no double quotes / $ / [ ].)
const CASES = [
  { mutates: true, text: 'crea un archivo saludo.js con una funcion saludo(nombre)' },
  {
    mutates: true,
    text: 'crea tres modulos JS totalmente independientes: header.js con una clase Header, footer.js con una clase Footer, y math.js con una clase Calc con metodos suma resta multiplica divide',
  },
  {
    mutates: true,
    text: 'add a file utils.js that exports a debounce function and a throttle function',
  },
  {
    mutates: true,
    text: 'implementa un pequeno modulo de validacion en validate.js con funciones para email, telefono y codigo postal',
  },
  { mutates: false, text: 'que hace este proyecto y como esta organizado' },
];

function bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'exc-cov-'));
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
    'providers:\n  default: kimi\n  kimi:\n    type: openai-compatible\n    baseUrl: https://api.moonshot.ai/v1\n    apiKeyEnv: MOONSHOT_API_KEY\n    model: kimi-k2.7-code\n    contextWindow: 262144\n    capabilities:\n      reasoning: true\n      tools: true\n',
  );
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

/** Runs ONE task in a fresh shell and returns the on-disk product state. */
function runOne(dir, text) {
  const exp = join(tmpdir(), `exc-cov-${Math.random().toString(36).slice(2, 8)}.exp`);
  writeFileSync(
    exp,
    [
      `set timeout 240`,
      `spawn node ${CLI}`,
      `expect {`,
      `  -re "(automatically|automáticamente)" { send -- "y\\r"; exp_continue }`,
      `  -re "(construir o arreglar|What do you|›)" {}`,
      `  timeout {}`,
      `}`,
      `sleep 2`,
      `send -- "${text}\\r"`,
      // Wait until the turn FULLY SETTLES — the idle placeholder only returns after
      // the build (swarm merge included) completes and the post-turn materialization
      // hook has run. Waiting on the receipt/board line alone cut swarms mid-flight
      // (board materialized, but files not yet merged to the main tree).
      `set timeout 300`,
      `expect {`,
      `  -re "(Pide un cambio|Describe|empieza algo nuevo|› .*escribe)" {}`,
      `  timeout {}`,
      `}`,
      `sleep 3`,
      `send -- "/exit\\r"`,
      `sleep 2`,
      `exit 0`,
    ].join('\n'),
  );
  try {
    execFileSync('expect', [exp], { cwd: dir, env, timeout: 400_000 });
  } catch {
    /* the disk assert below is the evidence */
  } finally {
    rmSync(exp, { force: true });
  }
  const list = (p) =>
    existsSync(join(dir, '.excalibur', p)) ? readdirSync(join(dir, '.excalibur', p)) : [];
  const plans = list('plans').filter((f) => f.endsWith('.plan.json')).length;
  const items = list('work-items').filter((f) => /^WI-\d+\.json$/.test(f)).length;
  const sprints = list('sprints').filter((f) => f.endsWith('.json'));
  const activeSprint = sprints.some((f) => {
    try {
      return (
        JSON.parse(readFileSync(join(dir, '.excalibur', 'sprints', f), 'utf8')).status === 'active'
      );
    } catch {
      return false;
    }
  });
  const mutated = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: dir,
    encoding: 'utf8',
  })
    .split('\n')
    .some((l) => l.slice(3).trim().length > 0 && !l.slice(3).includes('.excalibur'));
  return { plans, items, activeSprint, mutated };
}

console.log('\n  MATERIALIZATION COVERAGE — does EVERY mutating turn leave a work item? (Kimi)\n');
let pass = 0;
for (const c of CASES) {
  const dir = bootstrap();
  const r = runOne(dir, c.text);
  let ok;
  if (c.mutates) {
    // THE GUARANTEE (the user's concern verbatim): a build request leaves a plan +
    // ≥1 work item + an active sprint — whatever path the classifier chose. Whether
    // the files are already merged into the main tree at check time is build-
    // completion timing, not a materialization fact, so it is shown but not gating.
    ok = r.plans >= 1 && r.items >= 1 && r.activeSprint;
  } else {
    // A pure question must board NOTHING (and not mutate).
    ok = !r.mutated && r.items === 0;
  }
  console.log(
    `  ${ok ? '✓' : '✗'} [${c.mutates ? 'mutate' : 'ask   '}] plans:${r.plans} items:${r.items} ` +
      `sprint:${r.activeSprint} mutated:${r.mutated} · "${c.text.slice(0, 46)}…"`,
  );
  if (ok) {
    pass += 1;
    rmSync(dir, { recursive: true, force: true });
  } else {
    console.log(`      forensics: ${dir}`);
  }
}

console.log(`\n  ${pass}/${CASES.length} cases passed`);
if (pass === CASES.length) {
  console.log('  ✓ PASS — every mutating turn leaves structured state; questions stay clean.\n');
  process.exit(0);
}
console.error('  ✗ FAIL — some mutating turns still leave no work item.\n');
process.exit(1);
