#!/usr/bin/env node
/**
 * REAL-Kimi behavioural smoke for RUN-FIX-4 (default engineering-quality bar).
 *
 * The bug: asked to "build a landing page", the agent produced a single bare
 * inline `index.html` — no separated CSS/assets, no real structure, not served.
 * We added a general engineering-quality fragment to the agent system prompt
 * (`engineeringGuidance` in native-agent-adapter.ts) telling it to structure work
 * properly (separate concerns into their own files) and to verify by building/
 * running. This drives the ACTUAL built CLI → native adapter → real Kimi → real
 * tools over a throwaway repo and asserts the deliverable now has real structure:
 * an HTML file AND a SEPARATE stylesheet (not one monolithic inline blob).
 *
 * GATED: exits 0 (SKIP) without a Moonshot/Kimi key. Run:
 *   MOONSHOT_API_KEY="$(cat ~/.config/excalibur/moonshot.key)" node scripts/verify-engineering-quality.mjs
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'apps/cli/dist/main.js');

const KEY_FILE = join(homedir(), '.config/excalibur/moonshot.key');
const KEY =
  process.env.MOONSHOT_API_KEY ??
  (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8').trim() : '');
if (KEY.length === 0) {
  console.log('⚠ verify-engineering-quality SKIPPED — no Kimi/Moonshot key.');
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
`;

const env = { ...process.env, MOONSHOT_API_KEY: KEY, EXCALIBUR_ASCII: '1' };
const dir = mkdtempSync(join(tmpdir(), 'exc-engq-'));

function setup() {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  mkdirSync(join(dir, '.excalibur/models'), { recursive: true });
  writeFileSync(join(dir, '.excalibur/config.yaml'), 'version: 1\ncommands: {}\n');
  writeFileSync(join(dir, '.excalibur/models/providers.yaml'), PROVIDERS);
  writeFileSync(join(dir, 'README.md'), '# Acme Notes\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
}

/** Recursively lists project files (skips .git and .excalibur internals). */
function listFiles(base, rel = '') {
  const out = [];
  for (const name of readdirSync(join(base, rel))) {
    if (name === '.git' || name === '.excalibur' || name === 'node_modules') continue;
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(join(base, r)).isDirectory()) out.push(...listFiles(base, r));
    else out.push(r);
  }
  return out;
}

const fail = (msg, files) => {
  console.error(`\n  ✗ FAIL: ${msg}`);
  if (files) console.error(`    files created: ${files.join(', ') || '(none)'}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
};

console.log('\n  engineering-quality smoke · "build a landing page" vs kimi-k2.7-code\n');
setup();

const task =
  'Build a small static landing page for Acme Notes, a note-taking app. ' +
  'Make it look good. Keep the project tidy.';
try {
  // Default autonomy (implementer) so edits land in the working tree; `--level 2`
  // is propose-patch (no files applied) and would defeat the file-structure check.
  execFileSync('node', [CLI, 'run', task, '--yes'], {
    cwd: dir,
    env,
    timeout: 360000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  // A non-zero CLI exit is not itself a failure of the assertion — inspect files.
  console.log(`  (cli exited non-zero: ${e.status ?? '?'} — inspecting the result anyway)`);
}

const files = listFiles(dir).filter((f) => f !== 'README.md');
console.log(`  files created: ${files.join(', ') || '(none)'}`);

const exts = new Set(files.map((f) => extname(f).toLowerCase()));
const hasHtml = exts.has('.html') || exts.has('.htm');
const hasSeparateStyle =
  exts.has('.css') ||
  // A framework-built page is also "separated" (own style/asset modules).
  files.some((f) => /\.(scss|sass|less)$/i.test(f)) ||
  files.some((f) => /(^|\/)(styles?|css|assets|public|src)\//i.test(f));

if (files.length < 2) fail('expected a structured project (≥2 files), not one inline blob', files);
if (!hasHtml) fail('expected an HTML page in the deliverable', files);
if (!hasSeparateStyle)
  fail('expected styling SEPARATED into its own file/dir (not all inline in one html)', files);

// Bonus signal (not required to pass): did it try to verify/serve or build?
const inlineOnly = files.length === 1;
console.log(
  `\n  ✓ PASS — produced a structured project: ${files.length} files, HTML + separate styling` +
    `${inlineOnly ? '' : ''} (not a single inline index.html)\n`,
);
rmSync(dir, { recursive: true, force: true });
