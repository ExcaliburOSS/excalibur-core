#!/usr/bin/env node
/**
 * RUN-FIX-26 proof: "revisa la web que hemos hecho y enséñamela" must READ the code itself,
 * (optionally) review it, and SERVE it on localhost via the `preview` tool — NOT dump a
 * read-only scope analysis that asks the user to share files. Drives the m-shell over a pty
 * against a tiny static-web repo and asserts: a localhost URL appears, and the read-only
 * scope dump ("Analizando (solo lectura)" / "Open questions" / "share public/index.html")
 * does NOT.
 *
 * GATED: SKIP without a Kimi key or `expect`. A real agent turn (read + serve) is slow.
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
  console.log('⚠ verify-preview-intent SKIPPED — no Kimi/Moonshot key.');
  process.exit(0);
}
try {
  execFileSync('which', ['expect'], { stdio: 'ignore' });
} catch {
  console.log('⚠ verify-preview-intent SKIPPED — `expect` not installed.');
  process.exit(0);
}
if (!existsSync(CLI)) {
  console.error('✗ CLI not built — run `pnpm -r build` first.');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'exc-preview-'));
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
// A tiny static-web project — the shape the user has: package.json start script + server + public/.
writeFileSync(
  join(dir, 'package.json'),
  JSON.stringify({ name: 'web', version: '1.0.0', scripts: { start: 'node server.js' } }, null, 2),
);
writeFileSync(
  join(dir, 'server.js'),
  [
    "const http = require('http');",
    "const fs = require('fs');",
    'const server = http.createServer((req, res) => {',
    "  res.setHeader('content-type', 'text/html');",
    "  res.end(fs.readFileSync('public/index.html'));",
    '});',
    // Port 0 → the OS assigns a free port, so there is never an EADDRINUSE collision with a
    // leaked server from a prior run; print the ACTUAL localhost URL for `preview` to parse.
    "server.listen(0, '127.0.0.1', () => console.log(`Serving on http://127.0.0.1:${server.address().port}`));",
    '',
  ].join('\n'),
);
mkdirSync(join(dir, 'public'), { recursive: true });
writeFileSync(
  join(dir, 'public', 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"><title>Demo</title></head><body><h1>Hello</h1></body></html>\n',
);
execFileSync('git', ['add', '-A'], { cwd: dir });
execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });

const env = { ...process.env, MOONSHOT_API_KEY: KEY, EXCALIBUR_ASCII: '1' };
const REQUEST = 'revisa la web que hemos hecho y enseñamela';

const exp = join(tmpdir(), 'exc-preview.exp');
writeFileSync(
  exp,
  [
    `set timeout 240`,
    `log_file -a /tmp/preview-intent-full.log`,
    `spawn node ${CLI}`,
    `expect {`,
    `  -re "(automáticamente|automatically)" { send -- "y\\r"; exp_continue }`,
    `  -re "(construir o arreglar|›)" {}`,
    `  timeout {}`,
    `}`,
    `sleep 2`,
    // land the request (box-init race guard: confirm the distinctive word "enseñamela" echoed)
    `set landed 0`,
    `for {set i 0} {$i < 3 && !$landed} {incr i} {`,
    `  send -- "${REQUEST}\\r"`,
    `  set timeout 25`,
    `  expect { -re "ense" { set landed 1 } timeout {} }`,
    `}`,
    `puts "PREVIEW_LANDED: $landed"`,
    // wait for the DECISIVE signal: the site is served on localhost (preview tool ran)
    `set served unknown`,
    `set timeout 200`,
    `expect {`,
    `  -re "aprobaci|approve automatically" { send -- "y\\r"; exp_continue }`,
    // Bracket-free patterns: the "127.0.0.1:" / "localhost:" prefix only prints when a server
    // is actually serving; "is live at" is execPreview's success line. (No TCL char class — an
    // escaped [0-9] would be read as a LITERAL, never matching the real dynamic port.)
    `  -re "127.0.0.1:|localhost:|is live at|The web app is live" { set served yes }`,
    `  timeout { set served no }`,
    `}`,
    `puts "PREVIEW_SERVED: $served"`,
    `sleep 3`,
    `send -- "/exit\\r"`,
    `sleep 2`,
    `exit 0`,
  ].join('\n'),
);

console.log(
  '\n  RUN-FIX-26 — does "revisa la web y enséñamela" read + serve (not dump a scope)? (Kimi)\n',
);
rmSync('/tmp/preview-intent-full.log', { force: true });
let out = '';
try {
  out = execFileSync('expect', [exp], { cwd: dir, env, timeout: 600000 }).toString();
} catch (e) {
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
}
const full = existsSync('/tmp/preview-intent-full.log')
  ? readFileSync('/tmp/preview-intent-full.log', 'utf8')
  : out;
// eslint-disable-next-line no-control-regex
const clean = full.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][0-9;]*/g, '');
for (const line of out.split('\n')) {
  if (/PREVIEW_(LANDED|SERVED)/.test(line)) console.log(`  ${line.trim()}`);
}
// Served if the expect matched OR the captured transcript shows a live localhost URL /
// execPreview's success line (robust against expect/pty timing flakes).
const served =
  /PREVIEW_SERVED: yes/.test(out) ||
  /127\.0\.0\.1:[0-9]+|localhost:[0-9]+|is live at|The web app is live/.test(clean);
const dumpedScope =
  /Analizando \(solo lectura\)|## Open questions|share public\/index\.html|no web app to preview/i.test(
    clean,
  );
console.log(`  served-on-localhost: ${served}`);
console.log(`  dumped-readonly-scope-or-asked-for-files: ${dumpedScope}`);
if (served && !dumpedScope) {
  rmSync(dir, { recursive: true, force: true });
  console.log('\n  ✓ PASS — it read the code and SERVED the site; no read-only scope dump.\n');
  process.exit(0);
}
console.error(`\n  ✗ FAIL — served=${served} dumpedScope=${dumpedScope}. Repo: ${dir}\n`);
console.error(clean.slice(-2500));
process.exit(1);
