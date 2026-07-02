#!/usr/bin/env node
/**
 * RUN-FIX-27 (non-TTY parity + localized rail verbs). Runs `excalibur run` with stdout PIPED
 * (so `describeEvent` — the non-TTY/CI streaming path — renders every line) in Spanish
 * (`EXCALIBUR_LANG=es`) against a REAL Kimi model, then asserts on the captured transcript:
 *
 *   1. LOCALIZED verbs — a real read/command renders as "leo …" / "ejecuto …" (never the
 *      English "read"/"run" and never a bare, uninformative "tool read_file").
 *   2. NO exit-code leak — no "exit 0" / "exit 1" line ever reaches the user (a benign probe
 *      returning non-zero must not read as a scary failure).
 *
 * GATED: SKIP cleanly without a Kimi/Moonshot key.
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
  console.log('⚠ verify-nontty-rail SKIPPED — no Kimi/Moonshot key.');
  process.exit(0);
}
if (!existsSync(CLI)) {
  console.error('✗ CLI not built — run `pnpm --filter @excalibur-oss/excalibur build` first.');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'exc-nontty-'));
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

const env = {
  ...process.env,
  MOONSHOT_API_KEY: KEY,
  EXCALIBUR_LANG: 'es',
  EXCALIBUR_ASCII: '1',
};
// A task that reliably induces BOTH a file read and a shell command.
const REQUEST =
  'Lee el archivo app.js y luego ejecuta el comando "node -e \'console.log(main())\'" para comprobar que arranca. No cambies nada.';

console.log('\n  Non-TTY rail — localized verbs + no exit-code leak (Kimi, stdout piped)\n');
let out = '';
try {
  // execFileSync captures stdout → NOT a TTY → the `describeEvent` streaming path.
  out = execFileSync('node', [CLI, 'run', REQUEST, '--yes', '--level', '3'], {
    cwd: dir,
    env,
    timeout: 240000,
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
} catch (e) {
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
}
// eslint-disable-next-line no-control-regex
const clean = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][0-9;]*/g, '');

// 1. LOCALIZED verbs: at least one Spanish tool verb rendered.
const localized = /\b(leo|ejecuto|busco|miro|escribo)\b/.test(clean);
// 2. NO exit-code leak anywhere in the transcript.
const exitLeak = /\bexit\s+-?\d+\b/i.test(clean);
// 3. NO bare, uninformative English tool line.
const bareTool = /\btool\s+(read_file|run_command|list_files|search_code)\b/.test(clean);
// English verb from THIS render path leaking through (localization missed a site).
const englishVerb = /^\s*(read|run|search|list)\s+\S/m.test(clean);

console.log(`  localized-verb-present:  ${localized}`);
console.log(`  exit-code-leak:          ${exitLeak}`);
console.log(`  bare-uninformative-tool: ${bareTool}`);
console.log(`  english-verb-leak:       ${englishVerb}`);

if (localized && !exitLeak && !bareTool && !englishVerb) {
  rmSync(dir, { recursive: true, force: true });
  console.log('\n  ✓ PASS — non-TTY rail is localized (es) and never shows an exit code.\n');
  process.exit(0);
}
console.error(
  `\n  ✗ FAIL — localized=${localized} exitLeak=${exitLeak} bareTool=${bareTool} englishVerb=${englishVerb}. Repo: ${dir}\n`,
);
console.error(clean.slice(-3000));
process.exit(1);
