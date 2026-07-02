#!/usr/bin/env node
/**
 * D5 proof — bracketed paste: pasting a MULTI-LINE snippet into the m-shell lands
 * as ONE message (Enter inside the paste is content), instead of one surprise
 * submit per line. Drives the REPL over a pty, sends the terminal's paste-marker
 * bytes (`ESC[200~ … ESC[201~`) around a two-line payload, then a real Enter, and
 * asserts exactly ONE mock turn containing BOTH lines. Mock provider — free.
 *
 * GATED: SKIP without `expect`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'apps/cli/dist/main.js');
try {
  execFileSync('which', ['expect'], { stdio: 'ignore' });
} catch {
  console.log('⚠ verify-d5-paste SKIPPED — `expect` not installed.');
  process.exit(0);
}
if (!existsSync(CLI)) {
  console.error('✗ CLI not built — run `pnpm --filter @excalibur-oss/excalibur build` first.');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'exc-d5-'));
// Pre-configured mock provider + L4/auto so the shell boots STRAIGHT to the
// prompt (a virgin dir opens the onboarding provider picker and would eat the
// paste in its filter).
mkdirSync(join(dir, '.excalibur/models'), { recursive: true });
writeFileSync(
  join(dir, '.excalibur/config.yaml'),
  'version: 1\napprovals:\n  auto: true\nautonomy:\n  default: 4\n',
);
writeFileSync(
  join(dir, '.excalibur/models/providers.yaml'),
  'providers:\n  default: mock\n  mock:\n    type: mock\n',
);
const env = { ...process.env, EXCALIBUR_ASCII: '1', EXCALIBUR_DASHBOARD: 'off' };

const exp = join(tmpdir(), 'exc-d5.exp');
writeFileSync(
  exp,
  [
    `set timeout 60`,
    `spawn node ${CLI}`,
    `expect {`,
    `  -re "(automatically|automáticamente)" { send -- "y\\r"; exp_continue }`,
    `  -re "(construir o arreglar|What do you|Describe|›)" {}`,
    `  timeout {}`,
    `}`,
    `sleep 2`,
    // The terminal's bracketed-paste frame around a two-line payload. If the fix
    // is absent, the \n inside SUBMITS line one immediately (a first mock turn).
    `send -- "\\x1b\\[200~primera linea pegada`,
    `segunda linea pegada\\x1b\\[201~"`,
    `sleep 2`,
    // Now the REAL Enter — the whole two-line message submits as ONE turn.
    `send -- "\\r"`,
    `set timeout 60`,
    `expect {`,
    `  -re "Mock provider" {}`,
    `  timeout { puts "D5_NOTE: no mock reply" }`,
    `}`,
    `sleep 3`,
    `send -- "/exit\\r"`,
    `sleep 2`,
    `exit 0`,
  ].join('\n'),
);

console.log('\n  D5 — does a pasted multi-line snippet land as ONE message? (mock)\n');
let out = '';
try {
  out = execFileSync('expect', [exp], { cwd: dir, env, timeout: 180_000 }).toString();
} catch (e) {
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
}

// Exactly ONE mock turn (one submit), and its prompt carried BOTH pasted lines.
const mockReplies = (out.match(/Mock provider/g) ?? []).length;
const sawBoth = out.includes('primera linea pegada') && out.includes('segunda linea pegada');
console.log(`  mock turns: ${mockReplies} · both lines present: ${sawBoth}`);
if (process.env.D5_DEBUG === '1') console.log('----TRANSCRIPT----\n' + out.slice(-3000));

rmSync(dir, { recursive: true, force: true });
if (mockReplies === 1 && sawBoth) {
  console.log('\n  ✓ PASS — the paste landed as ONE multi-line message (single submit).\n');
  process.exit(0);
}
console.error('\n  ✗ FAIL — the paste split into multiple submits (or never landed).\n');
process.exit(1);
