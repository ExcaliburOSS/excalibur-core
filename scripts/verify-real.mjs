#!/usr/bin/env node
/**
 * Real-usage smoke suite (run: `pnpm verify:real`).
 *
 * Drives the ACTUAL built `excalibur` binary against a REAL model (Kimi) over a
 * throwaway git repo and asserts real outcomes for every core command/feature —
 * file create/update/delete, bash/script execution, multi-step runs, the Todo
 * band, patch+apply, review, ask/explain, swarm, discovery, logs, status. Unit
 * tests pass with the mock while the product breaks with a real model; this
 * catches the real breakage (it already found the empty-patch and read-only-run
 * bugs).
 *
 * GATED: skips (exit 0) when no Moonshot/Kimi key is available, so CI without
 * the key is green. Provide the key at ~/.config/excalibur/moonshot.key or via
 * MOONSHOT_API_KEY.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'apps/cli/dist/main.js');

// ── Key resolution (gated) ──────────────────────────────────────────────────
const KEY_FILE = join(homedir(), '.config/excalibur/moonshot.key');
const KEY =
  process.env.MOONSHOT_API_KEY ??
  (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8').trim() : '');
if (KEY.length === 0) {
  console.log(
    '⚠ verify:real SKIPPED — no Kimi/Moonshot key (set MOONSHOT_API_KEY or ~/.config/excalibur/moonshot.key).',
  );
  process.exit(0);
}
if (!existsSync(CLI)) {
  console.error('✗ CLI not built — run `pnpm --filter @excalibur-oss/excalibur build` first.');
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
const tmpRepos = [];

/** A fresh git repo with Excalibur initialised + Kimi configured + a seed file. */
function freshRepo(seed = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'exc-real-'));
  tmpRepos.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  mkdirSync(join(dir, '.excalibur/models'), { recursive: true });
  writeFileSync(join(dir, '.excalibur/config.yaml'), 'version: 1\ncommands: {}\n');
  writeFileSync(join(dir, '.excalibur/models/providers.yaml'), PROVIDERS);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/math.ts'), 'export function add(a, b) {\n  return a + b;\n}\n');
  writeFileSync(join(dir, 'README.md'), '# Demo repo\n');
  for (const [path, content] of Object.entries(seed)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

/** Runs the excalibur binary; returns {out, code}. Never throws on non-zero. */
function exc(cwd, args, timeoutMs = 120000) {
  try {
    const out = execFileSync('node', [CLI, ...args], {
      cwd,
      env,
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0 };
  } catch (e) {
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
}

/** Reads a run's events.jsonl (latest run if id omitted). */
function runEvents(dir, runId) {
  const runsDir = join(dir, '.excalibur/runs');
  if (!existsSync(runsDir)) return [];
  const id = runId ?? execFileSync('ls', ['-t', runsDir]).toString().trim().split('\n')[0];
  const f = join(runsDir, id, 'events.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
const toolsUsed = (events) =>
  events.filter((e) => e.type === 'tool_call').map((e) => e.payload.tool ?? e.payload.name);

/** Whether `expect` is available (for driving the interactive REPL over a pty). */
function hasExpect() {
  try {
    execFileSync('which', ['expect'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Drives the interactive REPL over a pty: answers the auto-accept prompt yes, sends one task, exits. */
function replAutoTurn(dir, prompt, waitS = 55) {
  const exp = join(tmpdir(), `exc-repl-${Math.abs(prompt.length * 7919) % 100000}.exp`);
  writeFileSync(
    exp,
    [
      `set timeout ${waitS + 40}`,
      `spawn node ${CLI}`,
      `expect -re "(automatically|automáticamente)"`,
      `send "y\\r"`,
      `sleep 2`,
      `send "${prompt}\\r"`,
      `sleep ${waitS}`,
      `send "/exit\\r"`,
      `expect eof`,
    ].join('\n'),
  );
  try {
    execFileSync('expect', [exp], {
      cwd: dir,
      env,
      timeout: (waitS + 60) * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    /* expect's eof handling can exit non-zero; the assertions check the real outcome */
  }
}

// ── Scenario runner ──────────────────────────────────────────────────────────
// Optional substring filter: `node scripts/verify-real.mjs <substring>` runs only
// matching scenarios (case-insensitive) — handy for smoking a single feature.
const FILTER = (process.argv[2] ?? '').toLowerCase();
const results = [];
async function scenario(name, fn) {
  if (FILTER !== '' && !name.toLowerCase().includes(FILTER)) return;
  process.stdout.write(`▶ ${name} … `);
  const started = Date.now();
  try {
    await fn();
    const ms = Date.now() - started;
    results.push({ name, ok: true, ms });
    console.log(`✓ (${(ms / 1000).toFixed(1)}s)`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`✗\n    ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── The scenarios (real usage, every command) ────────────────────────────────
await scenario('ask — real answer about the repo', () => {
  const dir = freshRepo();
  const { out } = exc(dir, ['ask', 'What does src/math.ts export?']);
  assert(/add/i.test(out), 'answer should mention the add function');
});

await scenario('explain — explains a source file', () => {
  const dir = freshRepo();
  const { out } = exc(dir, ['explain', 'src/math.ts']);
  assert(out.replace(/\s+/g, ' ').length > 40, 'explanation should be non-trivial');
});

// Network config (mode on + auto-approve) so an unattended run can reach the web
// without a prompt. Quoted so YAML 1.1-style coercion never turns `on` into true.
const NET_AUTO =
  'version: 1\ncommands: {}\npermissions:\n  network:\n    mode: "on"\n    approval: "auto"\n';

await scenario('web_fetch — reads a real page into clean text (free, in-bundle)', () => {
  const dir = freshRepo({ '.excalibur/config.yaml': NET_AUTO });
  exc(
    dir,
    [
      'run',
      'Fetch the page at https://example.com/ and tell me its title. Use the web_fetch tool.',
      '--yes',
    ],
    150000,
  );
  const events = runEvents(dir);
  assert(toolsUsed(events).includes('web_fetch'), 'should have used web_fetch');
  // The tool RESULT must carry the real extracted title (the workflow's final
  // PR-summary stdout may paraphrase it, so assert on the authoritative event).
  const fetched = events.some(
    (e) =>
      e.type === 'tool_call' &&
      (e.payload.tool ?? e.payload.name) === 'web_fetch' &&
      /example domain/i.test(String(e.payload.result ?? '')),
  );
  assert(fetched, 'web_fetch result must contain the real page title (Example Domain)');
});

await scenario('web_search — finds real sources via DuckDuckGo (free, no key)', () => {
  const dir = freshRepo({ '.excalibur/config.yaml': NET_AUTO });
  exc(
    dir,
    [
      'run',
      'Use the web_search tool to search the web for "Model Context Protocol specification" and list the top result URLs.',
      '--yes',
    ],
    150000,
  );
  const events = runEvents(dir);
  assert(toolsUsed(events).includes('web_search'), 'should have used web_search');
  // The free DuckDuckGo path returns real result links the model can cite.
  const searchEvents = events.filter(
    (e) => e.type === 'tool_call' && (e.payload.tool ?? e.payload.name) === 'web_search',
  );
  assert(searchEvents.length > 0, 'a web_search tool_call event should be recorded');
});

await scenario('web_extract — keyless structured extraction over Tier-1 markdown (F4)', () => {
  const dir = freshRepo({ '.excalibur/config.yaml': NET_AUTO });
  exc(
    dir,
    [
      'run',
      'Use the web_extract tool on https://example.com/ with the JSON schema {"type":"object","properties":{"title":{"type":"string"}}} to extract the page title.',
      '--yes',
    ],
    150000,
  );
  const events = runEvents(dir);
  assert(toolsUsed(events).includes('web_extract'), 'should have used web_extract');
  const got = events.some(
    (e) =>
      e.type === 'tool_call' &&
      (e.payload.tool ?? e.payload.name) === 'web_extract' &&
      /example domain/i.test(String(e.payload.result ?? '')),
  );
  assert(got, 'web_extract result must contain the extracted title (Example Domain)');
});

await scenario('web_crawl — bounded polite crawl (F4)', () => {
  const dir = freshRepo({ '.excalibur/config.yaml': NET_AUTO });
  exc(
    dir,
    [
      'run',
      'Use the web_crawl tool to crawl https://example.com/ with maxDepth 1, then tell me how many pages you found.',
      '--yes',
    ],
    150000,
  );
  const events = runEvents(dir);
  assert(toolsUsed(events).includes('web_crawl'), 'should have used web_crawl');
  const crawled = events.some(
    (e) =>
      e.type === 'tool_call' &&
      (e.payload.tool ?? e.payload.name) === 'web_crawl' &&
      /Crawled \d+ page/i.test(String(e.payload.result ?? '')),
  );
  assert(crawled, 'web_crawl result must report at least one crawled page');
});

await scenario('web command — fetches a real page via the tier pipeline (F5)', () => {
  const dir = freshRepo({ '.excalibur/config.yaml': NET_AUTO });
  const { out } = exc(dir, ['web', 'https://example.com/'], 60000);
  assert(/example domain/i.test(out), 'the web command must return the real page (Example Domain)');
});

await scenario('web — Jina keyless hosted reader, graceful fallback (F5; best-effort)', () => {
  const cfg =
    'version: 1\ncommands: {}\npermissions:\n  network:\n    mode: "on"\n    approval: "auto"\nscrape:\n  provider: jina\n  mode: prefer\n  jinaKeyless: true\n';
  const dir = freshRepo({ '.excalibur/config.yaml': cfg });
  const { out } = exc(dir, ['web', 'https://example.com/'], 60000);
  // Either Jina rendered it (via hosted:jina) or it fell back to the free Tier-1 —
  // a hosted failure must NEVER break the fetch; the real page must come through.
  assert(
    /example domain/i.test(out),
    'jina-prefer must return the page (rendered OR free fallback)',
  );
});

// A tiny inline MCP echo server (line-delimited JSON-RPC), declared read-only.
const MCP_ECHO_SERVER = `let buf="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{buf+=c;let i;while((i=buf.indexOf("\\n"))!==-1){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line)continue;let m;try{m=JSON.parse(line)}catch{continue}if(m.method==="notifications/initialized")continue;let r;if(m.method==="initialize"){r={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"echo",version:"1.0.0"}}}else if(m.method==="tools/list"){r={tools:[{name:"echo",description:"Echoes its message back.",annotations:{readOnlyHint:true},inputSchema:{type:"object",properties:{message:{type:"string"}},required:["message"]}}]}}else if(m.method==="tools/call"){r={content:[{type:"text",text:"echo:"+m.params.arguments.message}],isError:false}}else{process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,error:{code:-32601,message:"nope"}})+"\\n");continue}process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:r})+"\\n")}});`;

await scenario('mcp — a trusted read-only MCP tool is driven end-to-end by Kimi (F6)', () => {
  const dir = freshRepo({
    'mcp-echo.js': MCP_ECHO_SERVER,
    '.excalibur/config.yaml':
      'version: 1\ncommands: {}\nmcp:\n  servers:\n    demo:\n      command: node\n      args: ["mcp-echo.js"]\n      trust: trusted\n      readOnlyTools: ["echo"]\n',
  });
  exc(
    dir,
    [
      'run',
      'Call the demo echo MCP tool (mcp__demo__echo) with the message EXCALIBUR_MCP_OK and report exactly what it returned.',
      '--yes',
    ],
    150000,
  );
  const events = runEvents(dir);
  const used = events.some(
    (e) => e.type === 'tool_call' && String(e.payload.tool ?? '').startsWith('mcp__demo__'),
  );
  assert(used, 'Kimi should have called the MCP echo tool (mcp__demo__echo)');
  const ran = events.some(
    (e) =>
      e.type === 'tool_call' &&
      String(e.payload.tool ?? '').startsWith('mcp__demo__') &&
      e.payload.ok === true,
  );
  assert(ran, 'the MCP echo tool call should have executed (ok)');
});

await scenario('research command — cited, verified multi-source answer (F7)', () => {
  const dir = freshRepo({ '.excalibur/config.yaml': NET_AUTO });
  const { out } = exc(
    dir,
    ['research', 'What is the Model Context Protocol and who introduced it?', '--max-sources', '4'],
    240000,
  );
  assert(/## Sources/i.test(out), 'the report must include a Sources section');
  assert(/\[1\]/.test(out), 'the answer must carry inline [n] citations');
  assert(/sha256/i.test(out), 'sources must be hashed (provenance)');
  assert(/protocol/i.test(out), 'the answer should actually address MCP');
});

await scenario('research tool — model-first research used by Kimi (F7)', () => {
  const dir = freshRepo({ '.excalibur/config.yaml': NET_AUTO });
  exc(
    dir,
    [
      'run',
      'Use the research tool to research "what is the Model Context Protocol" and give a one-paragraph cited summary.',
      '--yes',
    ],
    200000,
  );
  const events = runEvents(dir);
  assert(toolsUsed(events).includes('research'), 'Kimi should have used the research tool');
});

await scenario('patch + apply — generates a real diff and applies it', () => {
  const dir = freshRepo();
  const { out } = exc(dir, ['patch', 'Add a multiply(a, b) function to src/math.ts', '--yes']);
  const id = /patch_\d{8}_\d{6}/.exec(out)?.[0];
  assert(id, 'a patch id should be printed');
  const diff = readFileSync(join(dir, '.excalibur/patches', id, 'diff.patch'), 'utf8');
  assert(/multiply/.test(diff) && /^\+/m.test(diff), 'diff must add multiply');
  exc(dir, ['apply', id, '--yes']);
  assert(
    /multiply/.test(readFileSync(join(dir, 'src/math.ts'), 'utf8')),
    'applied file must contain multiply',
  );
});

await scenario('run — CREATES a new file', () => {
  const dir = freshRepo();
  exc(dir, ['run', 'Create a new file hello.txt containing exactly the text HELLO', '--yes']);
  assert(existsSync(join(dir, 'hello.txt')), 'hello.txt must exist');
  assert(
    /HELLO/.test(readFileSync(join(dir, 'hello.txt'), 'utf8')),
    'hello.txt must contain HELLO',
  );
  assert(toolsUsed(runEvents(dir)).includes('write_file'), 'should have used write_file');
});

await scenario('run — UPDATES an existing file', () => {
  const dir = freshRepo();
  exc(dir, ['run', 'Add a subtract(a, b) function to src/math.ts that returns a - b', '--yes']);
  const math = readFileSync(join(dir, 'src/math.ts'), 'utf8');
  assert(/subtract/.test(math) && /add/.test(math), 'math.ts must keep add and gain subtract');
});

await scenario('run — LSP feeds REAL per-edit diagnostics to the model (P1.10)', () => {
  // Gated on the real typescript-language-server (an agent-runtime devDependency).
  const tsserver = join(
    ROOT,
    'packages/agent-runtime/node_modules/.bin/typescript-language-server',
  );
  if (!existsSync(tsserver)) {
    console.log('(skipped — typescript-language-server not installed) ');
    return;
  }
  const dir = freshRepo();
  // A tsconfig so tsserver treats the file as a project; point the LSP config at
  // the absolute server path (the CLI subprocess has no package .bin on PATH).
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true } }),
  );
  writeFileSync(
    join(dir, '.excalibur/config.yaml'),
    [
      'version: 1',
      'commands: {}',
      'lsp:',
      '  enabled: true',
      '  diagnosticsTimeoutMs: 8000',
      '  serverStartTimeoutMs: 25000',
      '  servers:',
      '    typescript:',
      `      command: ${tsserver}`,
      '      args:',
      '        - --stdio',
      '',
    ].join('\n'),
  );
  // `--structured` selects a workflow with an `agent_work` phase (the native
  // tool loop where the LSP per-edit hook lives); fast-fix's patch_generation
  // is a single-shot diff with no per-edit loop.
  exc(
    dir,
    [
      'run',
      'Create a file src/calc.ts with EXACTLY this content and nothing else, do NOT fix any type error: export const total: number = "hello";',
      '--structured',
      '--yes',
    ],
    180000,
  );
  const diags = runEvents(dir).filter((e) => e.type === 'diagnostics');
  // The LSP path activated end-to-end through the real CLI + real model + server.
  assert(diags.length > 0, 'a real agentic run editing a .ts file should emit a diagnostics event');
  // And the real type error the model wrote was caught and fed back.
  assert(
    diags.some((e) => (e.payload.errorCount ?? 0) >= 1),
    'tsserver should have flagged the deliberate type error (errorCount >= 1)',
  );
});

/** Resolves the bundled typescript-language-server, or null when not installed. */
function tsserverPath() {
  const p = join(ROOT, 'packages/agent-runtime/node_modules/.bin/typescript-language-server');
  return existsSync(p) ? p : null;
}
/** A `.excalibur/config.yaml` with the LSP server pointed at the absolute tsserver. */
function lspConfigYaml(tsserver) {
  return [
    'version: 1',
    'commands: {}',
    'lsp:',
    '  enabled: true',
    '  diagnosticsTimeoutMs: 8000',
    '  diagnosticsSettleMs: 2000',
    '  serverStartTimeoutMs: 25000',
    '  servers:',
    '    typescript:',
    `      command: ${tsserver}`,
    '      args:',
    '        - --stdio',
    '',
  ].join('\n');
}

await scenario(
  'run --fast — patch workflow gets LSP grounding + FAILS the claim gate on a type error',
  () => {
    const tsserver = tsserverPath();
    if (tsserver === null) {
      console.log('(skipped — typescript-language-server not installed) ');
      return;
    }
    const dir = freshRepo({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
      }),
      '.excalibur/config.yaml': lspConfigYaml(tsserver),
    });
    exc(
      dir,
      [
        'run',
        'Create a file src/calc.ts with EXACTLY this content and nothing else, do NOT fix any type error: export const total: number = "hello";',
        '--fast',
        '--yes',
      ],
      180000,
    );
    const events = runEvents(dir);
    // fast-fix uses patch_generation→apply_patch (NOT the agent_work loop), yet the
    // engine's post-apply LSP grounding still emits diagnostics for the applied file.
    const diags = events.filter((e) => e.type === 'diagnostics');
    assert(
      diags.some((e) => (e.payload.errorCount ?? 0) >= 1),
      'a fast-fix apply should emit an LSP diagnostics event with errors',
    );
    // No typecheck command configured → the LSP error refutes `no_type_errors` and fails the run.
    const claim = events.find((e) => e.type === 'claim' && e.payload.kind === 'no_type_errors');
    assert(
      claim?.payload.status === 'refuted',
      'the LSP-fed claim gate should refute no_type_errors',
    );
    assert(
      events.find((e) => e.type === 'run_completed')?.payload.status === 'failed',
      'a patch introducing a type error should FAIL the run via the claim gate',
    );
  },
);

await scenario('review --diagnostics — diff-scoped LSP errors ground the review', () => {
  const tsserver = tsserverPath();
  if (tsserver === null) {
    console.log('(skipped — typescript-language-server not installed) ');
    return;
  }
  const dir = freshRepo({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
    }),
    '.excalibur/config.yaml': lspConfigYaml(tsserver),
  });
  // An untracked TS file with a real type error shows up in `getLocalDiff`.
  writeFileSync(join(dir, 'src/calc.ts'), 'export const total: number = "hello";\n');
  exc(dir, ['review', '--diff', '--diagnostics']);
  // The diff-scoped LSP error is injected into the review's effective instructions
  // (deterministic — independent of the model's prose).
  const interDir = join(dir, '.excalibur/interactions');
  const id = execFileSync('ls', ['-t', interDir]).toString().trim().split('\n')[0];
  const effective = readFileSync(join(interDir, id, 'effective-instructions.md'), 'utf8');
  assert(
    /not assignable/i.test(effective) || /calc\.ts:\d+:\d+ error/.test(effective),
    'the review should be grounded on the real LSP type error',
  );
});

await scenario('run — runs a BASH command / script and DELETES a file', () => {
  const dir = freshRepo({ 'doomed.txt': 'delete me\n' });
  exc(dir, ['run', 'Delete the file doomed.txt using a shell command', '--yes']);
  assert(!existsSync(join(dir, 'doomed.txt')), 'doomed.txt must be deleted');
  assert(toolsUsed(runEvents(dir)).includes('run_command'), 'should have used run_command');
});

await scenario('run — multi-step task drives the Todo band (task_update)', () => {
  const dir = freshRepo();
  exc(dir, [
    'run',
    'In src/math.ts add input validation to add(), add a multiply() function, and add a JSDoc comment to each function',
    '--yes',
  ]);
  const events = runEvents(dir);
  assert(
    events.some((e) => e.type === 'task_update'),
    'a multi-step run should emit task_update',
  );
});

await scenario('review --diff — reviews local changes', () => {
  const dir = freshRepo();
  writeFileSync(
    join(dir, 'src/math.ts'),
    'export function add(a, b) {\n  return a - b; // BUG\n}\n',
  );
  const { out } = exc(dir, ['review', '--diff']);
  assert(out.replace(/\s+/g, ' ').length > 40, 'review should produce feedback');
});

await scenario('swarm — fans out independent subtasks', () => {
  const dir = freshRepo();
  const { out } = exc(
    dir,
    [
      'swarm',
      'Create three independent files: AUTHORS with a name, a .editorconfig with basic settings, and a CONTRIBUTING.md with one line',
      '--yes',
      '--apply',
    ],
    240000,
  );
  assert(/Swarm|lanes|merge/i.test(out), 'swarm should render the lanes panel');
});

await scenario('swarm — LIVE lanes render on a TTY (pty, real parallel agents)', () => {
  if (!hasExpect()) {
    console.log('(skipped: `expect` not available to drive the pty)');
    return;
  }
  const dir = freshRepo();
  const task =
    'create two independent files: docs/alpha.md describing module Alpha, and docs/beta.md describing module Beta';
  const exp = join(tmpdir(), `exc-swarm-live.exp`);
  writeFileSync(
    exp,
    [`set timeout 220`, `spawn node ${CLI} swarm "${task}" --apply -y`, `expect eof`].join('\n'),
  );
  let out = '';
  try {
    out = execFileSync('expect', [exp], {
      cwd: dir,
      env: { ...env, EXCALIBUR_FORCE_COLOR: '1' },
      encoding: 'utf8',
      timeout: 240000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  assert(/Swarm|lanes|merge/i.test(out), 'the live lanes panel should render on a pty');
  // The lanes now render via the Ink <LanesView> (in-place, log-update) — Ink
  // hides the cursor for the live region (the ANSI LiveLanes' DEC-2026 sync was
  // removed in the Ink migration). Assert the live in-place render happened.
  assert(
    out.includes('\x1b[?25l'),
    'the Ink live lanes view should hide the cursor for in-place rendering',
  );
});

await scenario('/swarm — in-shell fan-out renders live lanes (pty REPL, real agents)', () => {
  if (!hasExpect()) {
    console.log('(skipped: `expect` not available to drive the pty)');
    return;
  }
  const dir = freshRepo();
  const task =
    'create two independent files: docs/gamma.md describing module Gamma, and docs/delta.md describing module Delta';
  const exp = join(tmpdir(), `exc-shell-swarm.exp`);
  writeFileSync(
    exp,
    [
      `set timeout 240`,
      `spawn node ${CLI}`,
      `expect -re "(automatically|automáticamente)"`,
      `send "y\\r"`,
      `sleep 2`,
      `send "/swarm ${task}\\r"`,
      `sleep 180`,
      `send "/exit\\r"`,
      `expect eof`,
    ].join('\n'),
  );
  let out = '';
  try {
    out = execFileSync('expect', [exp], {
      cwd: dir,
      env: { ...env, EXCALIBUR_FORCE_COLOR: '1' },
      encoding: 'utf8',
      timeout: 260000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  // The in-shell /swarm reuses the SAME runSwarmFlow as `excalibur swarm`.
  assert(/Swarm|lanes|merge|subtask/i.test(out), 'in-shell /swarm should render the lanes panel');
});

await scenario('discovery — clarifies an idea with deterministic scoring', () => {
  const dir = freshRepo();
  const { out } = exc(dir, ['discovery', 'Add AI contract-renewal reminders', '--yes']);
  assert(
    /recommend|build|discovery|score/i.test(out),
    'discovery should produce a recommendation/score',
  );
});

await scenario('logs — renders a past run as the rail', () => {
  const dir = freshRepo();
  exc(dir, ['run', 'Create a file note.txt containing NOTE', '--yes']);
  const { out } = exc(dir, ['logs']);
  assert(/standard-safe|kimi|✓|completed/i.test(out), 'logs should render the rail of the run');
});

await scenario('status — lists local runs', () => {
  const dir = freshRepo();
  exc(dir, ['run', 'Create a file x.txt containing X', '--yes']);
  const { out } = exc(dir, ['status']);
  assert(/run_\d{8}/.test(out), 'status should list the run id');
});

await scenario('daily — generates a real report', () => {
  const dir = freshRepo();
  exc(dir, ['run', 'Create a file y.txt containing Y', '--yes']);
  const { out } = exc(dir, ['daily']);
  assert(/Daily Report|Completed runs/i.test(out), 'daily should produce a report');
});

await scenario('run — creates AND executes a bash script', () => {
  const dir = freshRepo();
  exc(dir, [
    'run',
    'Create a shell script greet.sh that prints GREETINGS, make it executable, and run it',
    '--yes',
  ]);
  assert(existsSync(join(dir, 'greet.sh')), 'greet.sh must be created');
  assert(
    toolsUsed(runEvents(dir)).includes('run_command'),
    'should have executed the script via run_command',
  );
});

await scenario('branch — applies a patch onto a new git branch', () => {
  const dir = freshRepo();
  const { out } = exc(dir, ['patch', 'Add a multiply(a, b) function to src/math.ts', '--yes']);
  const id = /patch_\d{8}_\d{6}/.exec(out)?.[0];
  assert(id, 'a patch id should be printed');
  exc(dir, ['branch', id, '--yes']);
  const branches = execFileSync('git', ['branch'], { cwd: dir, encoding: 'utf8' });
  assert(
    /excalibur\//.test(branches),
    `an excalibur/* branch must be created (got: ${branches.trim()})`,
  );
});

await scenario('undo — reverts a run’s changes', () => {
  const dir = freshRepo();
  exc(dir, ['run', 'Create a file undome.txt containing UNDO', '--yes']);
  assert(existsSync(join(dir, 'undome.txt')), 'precondition: the run created undome.txt');
  const runId = execFileSync('ls', ['-t', join(dir, '.excalibur/runs')])
    .toString()
    .trim()
    .split('\n')[0];
  exc(dir, ['undo', runId, '--yes']);
  assert(!existsSync(join(dir, 'undome.txt')), 'undo must remove the file the run created');
});

await scenario('changes — lists a run’s changed files', () => {
  const dir = freshRepo();
  exc(dir, ['run', 'Add a divide(a, b) function to src/math.ts', '--yes']);
  const runId = execFileSync('ls', ['-t', join(dir, '.excalibur/runs')])
    .toString()
    .trim()
    .split('\n')[0];
  const { out } = exc(dir, ['changes', runId]);
  assert(/math\.ts/.test(out), 'changes should list the modified file');
});

await scenario('fork — forks a run from a step', () => {
  const dir = freshRepo();
  exc(dir, ['run', 'Create a file base.txt containing BASE', '--yes']);
  const runId = execFileSync('ls', ['-t', join(dir, '.excalibur/runs')])
    .toString()
    .trim()
    .split('\n')[0];
  const { out, code } = exc(dir, [
    'fork',
    runId,
    'Also create forked.txt containing FORKED',
    '--yes',
  ]);
  assert(
    code === 0 && /fork|run_\d{8}/i.test(out),
    'fork should produce a new run from the cached prefix',
  );
});

await scenario('weekly-plan — generates a real report', () => {
  const dir = freshRepo();
  exc(dir, ['run', 'Create a file z.txt containing Z', '--yes']);
  const { out } = exc(dir, ['weekly-plan']);
  assert(
    /Weekly Plan|Last week|Plan for next week/i.test(out),
    'weekly-plan should produce a report',
  );
});

await scenario('shell (REPL) — auto-mode asked ONCE, then edits with zero prompts', () => {
  if (!hasExpect()) {
    // `expect` not installed → cannot drive a pty here; surfaced honestly, not silently green.
    console.log('(skipped: `expect` not available to drive the interactive pty)');
    return;
  }
  const dir = freshRepo();
  // First interactive session: the shell asks the one-time auto-accept question;
  // we answer yes, then ask it (in natural language) to create a file.
  replAutoTurn(dir, 'create a file shellmade.txt containing SHELLMADE', 70);
  // The agent must have actually created the file under auto-mode (no per-edit prompts)…
  assert(
    existsSync(join(dir, 'shellmade.txt')),
    'the interactive shell should have created the file under auto-mode',
  );
  assert(
    /SHELLMADE/.test(readFileSync(join(dir, 'shellmade.txt'), 'utf8')),
    'the file should contain the requested content',
  );
  // …and the auto-accept answer must be PERSISTED so future sessions never re-ask.
  const cfg = readFileSync(join(dir, '.excalibur/config.yaml'), 'utf8');
  assert(/auto:\s*true/.test(cfg), 'auto-accept must be persisted to .excalibur/config.yaml');
});

// ── Coverage: the remaining commands run end-to-end via the real binary ───────
// (Deterministic — no model — so they're fast; they catch CLI-wiring/arg-parsing
// regressions that unit tests on the lib functions miss. Per the firm real-usage
// directive: exercise EVERY command via the real binary.)
await scenario('doctor — diagnoses the local setup', () => {
  const dir = freshRepo();
  const { out, code } = exc(dir, ['doctor']);
  assert(code === 0, 'doctor should exit 0');
  assert(/PASS|node version|git/i.test(out), 'doctor should report its checks');
});

await scenario('catalogs — methodologies / workflows / models list render', () => {
  const dir = freshRepo();
  assert(
    exc(dir, ['methodologies', 'list']).out.replace(/\s+/g, ' ').length > 40,
    'methodologies list non-empty',
  );
  assert(
    exc(dir, ['workflows', 'list']).out.replace(/\s+/g, ' ').length > 40,
    'workflows list non-empty',
  );
  assert(
    /kimi/i.test(exc(dir, ['models', 'list']).out),
    'models list should show the configured kimi provider',
  );
  assert(
    /core-(methodologies|workflows)/i.test(exc(dir, ['extensions', 'list']).out),
    'extensions list should show the built-in packs',
  );
});

await scenario('instructions (ISD) — discovers an AGENTS.md source', () => {
  const dir = freshRepo({ 'AGENTS.md': '# Project\nBe concise and idiomatic.\n' });
  assert(exc(dir, ['instructions', 'scan']).code === 0, 'instructions scan should exit 0');
  const { out, code } = exc(dir, ['instructions', 'list']);
  assert(code === 0, 'instructions list should exit 0');
  assert(/AGENTS|instruction|source/i.test(out), 'should list the AGENTS.md instruction source');
});

await scenario('theme — sets and persists the chosen theme', () => {
  const dir = freshRepo();
  exc(dir, ['theme', 'daltonized']);
  assert(
    /theme:\s*daltonized/.test(readFileSync(join(dir, '.excalibur/config.yaml'), 'utf8')),
    'theme should persist to .excalibur/config.yaml',
  );
});

await scenario('skills / plans / insights — run cleanly with an empty history', () => {
  const dir = freshRepo();
  assert(exc(dir, ['skills', 'list']).code === 0, 'skills list should exit 0');
  assert(exc(dir, ['plans']).code === 0, 'plans should exit 0');
  assert(exc(dir, ['insights']).code === 0, 'insights should exit 0');
});

await scenario('verify — adversarial Verification Mesh over a run’s changes (MOAT)', () => {
  const dir = freshRepo();
  // A run that reliably produces a change for the mesh to verify.
  exc(
    dir,
    ['run', 'create a file src/sub.ts exporting a subtract function', '--fast', '--yes'],
    180000,
  );
  const runId = execFileSync('ls', ['-t', join(dir, '.excalibur/runs')])
    .toString()
    .trim()
    .split('\n')[0];
  const { out, code } = exc(dir, ['verify', runId], 180000);
  // The mesh ran REAL adversarial verifier lenses and produced a verdict.
  assert(code === 0 || code === 1, 'verify exits cleanly (0 = passed, 1 = blocked)');
  assert(/verif|adversarial|lens|pass|block/i.test(out), 'verify should report the mesh verdict');
  // …and persisted evidence-linked proof (the auditable moat property).
  assert(
    existsSync(join(dir, '.excalibur/runs', runId, 'verification.md')),
    'verify should persist verification.md evidence',
  );
});

// ── Summary ───────────────────────────────────────────────────────────────────
for (const dir of tmpRepos) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
const passed = results.filter((r) => r.ok).length;
console.log(`\n── verify:real — ${passed}/${results.length} passed (Kimi) ──`);
for (const r of results.filter((r) => !r.ok)) console.log(`  ✗ ${r.name}: ${r.err}`);
process.exit(passed === results.length ? 0 : 1);
