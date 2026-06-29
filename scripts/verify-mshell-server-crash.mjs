#!/usr/bin/env node
/**
 * REAL-Kimi e2e reproducing the USER'S EXACT crash scenario (the 5th report): a WEB
 * build whose verification BACKGROUNDS a real server.js, curls it, then exits 1 —
 * `node server.js & ... wait $SERVER_PID (exit 1)`. The build self-heals, exhausts,
 * shows the red receipt, and MUST return to a live prompt — never exit the m-shell.
 *
 * If the shell exits here (the bug), the follow-up `!echo <MARKER>` never prints.
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
  console.log('⚠ verify-mshell-server-crash SKIPPED — no Kimi/Moonshot key.');
  process.exit(0);
}
try {
  execFileSync('which', ['expect'], { stdio: 'ignore' });
} catch {
  console.log('⚠ verify-mshell-server-crash SKIPPED — `expect` not installed.');
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
const env = {
  ...process.env,
  MOONSHOT_API_KEY: KEY,
  EXCALIBUR_ASCII: '1',
  EXCALIBUR_DEBUG_EXIT: '/tmp/exc-exit.log',
};
const dir = mkdtempSync(join(tmpdir(), 'exc-servercrash-'));
const MARKER = 'STILL_ALIVE_AFTER_SERVER_BUILD';

function setup() {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  mkdirSync(join(dir, '.excalibur/models'), { recursive: true });
  // The verification BACKGROUNDS a real long-lived server, curls it, kills it, then
  // exits 1 — the user's exact failing-check shape (a server holding stdio open).
  const test = [
    'node server.js &',
    'SERVER_PID=$!',
    'sleep 2',
    'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ || true',
    'echo ""',
    'kill $SERVER_PID 2>/dev/null || true',
    'wait $SERVER_PID 2>/dev/null || true',
    'exit 1',
  ].join('; ');
  writeFileSync(join(dir, '.excalibur/config.yaml'), `version: 1\ncommands:\n  test: '${test}'\n`);
  writeFileSync(join(dir, '.excalibur/models/providers.yaml'), PROVIDERS);
  // A real server that LISTENS FOREVER (inherits + holds the stdio pipes when bg'd).
  writeFileSync(
    join(dir, 'server.js'),
    "const http=require('http');http.createServer((q,r)=>r.end('ok')).listen(3000,()=>console.log('listening'));\n",
  );
  writeFileSync(join(dir, 'index.js'), "console.log('app');\n");
  writeFileSync(
    join(dir, 'package.json'),
    '{"name":"web","version":"1.0.0","scripts":{"start":"node server.js"}}\n',
  );
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
}

function drive() {
  const exp = join(tmpdir(), 'exc-servercrash.exp');
  writeFileSync(
    exp,
    [
      `set timeout 600`,
      `spawn node ${CLI}`,
      `expect -re "(automatically|automáticamente)"`,
      `send "y\\r"`,
      `expect -re "(construir o arreglar|What|Describe)"`,
      `sleep 1`,
      `send "añade un comentario de cabecera JSDoc en la primera linea de index.js explicando que hace\\r"`,
      // CLEAN crash signal: the IDLE prompt placeholder only re-renders if the REPL
      // loop SURVIVED the build and looped back to editor.question(). If the shell
      // exited on the failed build, this never returns → timeout. Generous wait for
      // the slow Kimi build + the self-heal attempts + the 120s server-check timeouts.
      `set alive 0`,
      `expect -timeout 540 -re "construir o arreglar" { set alive 1 } timeout { set alive 0 }`,
      `if {$alive == 1} {`,
      // Double-confirm the live prompt actually runs a command.
      `  send "!echo ${MARKER}\\r"`,
      `  expect -timeout 20 -re "${MARKER}"`,
      `}`,
      `send "/exit\\r"`,
      `expect eof`,
    ].join('\n'),
  );
  try {
    const t = execFileSync('expect', [exp], {
      cwd: dir,
      env,
      timeout: 600 * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    writeFileSync('/tmp/exc-servercrash-full.txt', t);
    return t;
  } catch (e) {
    const t = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    writeFileSync('/tmp/exc-servercrash-full.txt', t);
    return t;
  }
}

console.log('\n  m-shell SURVIVES a failing SERVER build (user crash repro) · vs kimi-k2.7-code\n');
setup();
const out = drive();
const survived = out.includes(MARKER);
const buildRan = existsSync(join(dir, '.excalibur/runs'));
console.log(`  gated build ran:                              ${buildRan}`);
console.log(`  shell survived + ran a follow-up after build: ${survived}`);
if (!survived) {
  console.error(
    `\n  ✗ FAIL/REPRO: the m-shell did NOT survive — the follow-up never ran (it exited).`,
  );
  console.error('    (full transcript at /tmp/exc-servercrash-full.txt)');
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}
rmSync(dir, { recursive: true, force: true });
console.log(
  '\n  ✓ PASS — the failing SERVER build returned to a LIVE prompt; the m-shell never exited.\n',
);
