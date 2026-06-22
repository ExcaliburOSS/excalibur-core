/**
 * Real end-to-end ACP smoke (P1.5): drives the REAL `excalibur acp` server with
 * the extension's actual AcpClient over real stdio, against a real model (Groq).
 * Proves the client↔server wire contract: initialize → session/new →
 * session/prompt with streamed session/update notifications → stopReason.
 * Gated on GROQ_API_KEY. Run: `pnpm exec tsx apps/vscode/scripts/acp-smoke.mts`
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AcpClient, type AcpTransport } from '../src/acp-client.ts';

const CLI = resolve(import.meta.dirname, '../../cli/dist/main.js');
const KEY = process.env.GROQ_API_KEY ?? '';
if (KEY.length === 0) {
  console.log('⚠ ACP smoke SKIPPED — no GROQ_API_KEY.');
  process.exit(0);
}

const PROVIDERS = `providers:
  default: groq
  groq:
    type: openai-compatible
    baseUrl: https://api.groq.com/openai/v1
    apiKeyEnv: GROQ_API_KEY
    model: llama-3.3-70b-versatile
    contextWindow: 131072
    inputCostPerMillionTokensCents: 100
    outputCostPerMillionTokensCents: 300
`;

const dir = mkdtempSync(join(tmpdir(), 'exc-acp-'));
mkdirSync(join(dir, '.excalibur/models'), { recursive: true });
writeFileSync(join(dir, '.excalibur/config.yaml'), 'version: 1\ncommands: {}\n');
writeFileSync(join(dir, '.excalibur/models/providers.yaml'), PROVIDERS);

const child = spawn('node', [CLI, 'acp'], {
  cwd: dir,
  stdio: 'pipe',
  env: { ...process.env, EXCALIBUR_ASCII: '1' },
});

let lineHandler: (line: string) => void = () => {};
let closeHandler: () => void = () => {};
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  buffer += chunk;
  let nl = buffer.indexOf('\n');
  while (nl >= 0) {
    lineHandler(buffer.slice(0, nl));
    buffer = buffer.slice(nl + 1);
    nl = buffer.indexOf('\n');
  }
});
child.on('close', () => closeHandler());

const transport: AcpTransport = {
  send: (m) => child.stdin.write(`${m}\n`),
  onLine: (h) => {
    lineHandler = h;
  },
  onClose: (h) => {
    closeHandler = h;
  },
  close: () => child.stdin.end(),
};

let chunks = 0;
const client = new AcpClient(transport, {
  onUpdate: (_s, u) => {
    if (u.sessionUpdate === 'agent_message_chunk') chunks += 1;
  },
  onPermission: () => Promise.resolve('allow'),
  onLog: () => {},
});

let failures = 0;
const ok = (m: string): void => console.log(`  ✓ ${m}`);
const bad = (m: string): void => {
  console.log(`  ✗ ${m}`);
  failures += 1;
};

function check(cond: boolean, good: string, ill: string): void {
  if (cond) ok(good);
  else bad(ill);
}

try {
  const init = await client.initialize();
  check(
    init.protocolVersion === 1,
    `initialize → protocolVersion ${init.protocolVersion}`,
    `unexpected protocolVersion: ${JSON.stringify(init)}`,
  );

  await client.authenticate();
  ok('authenticate → ok');

  const sessionId = await client.newSession(dir);
  check(sessionId.length > 0, `session/new → ${sessionId}`, 'empty sessionId');

  const { stopReason } = await client.prompt(
    sessionId,
    'Reply with a one-sentence greeting. Do not create or edit any files.',
  );
  check(
    stopReason === 'end_turn',
    `session/prompt → stopReason "${stopReason}"`,
    `unexpected stopReason "${stopReason}"`,
  );
  check(
    chunks > 0,
    `streamed ${chunks} assistant message chunk(s)`,
    'no assistant chunks streamed',
  );
} catch (error) {
  bad(`threw: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  client.dispose();
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  failures === 0 ? '\n✓ ACP real smoke PASSED' : `\n✗ ACP real smoke: ${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);
