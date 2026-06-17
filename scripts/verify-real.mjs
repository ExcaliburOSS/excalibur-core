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
  console.log('⚠ verify:real SKIPPED — no Kimi/Moonshot key (set MOONSHOT_API_KEY or ~/.config/excalibur/moonshot.key).');
  process.exit(0);
}
if (!existsSync(CLI)) {
  console.error('✗ CLI not built — run `pnpm --filter @excalibur/cli build` first.');
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
    const out = execFileSync('node', [CLI, ...args], { cwd, env, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
  return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const toolsUsed = (events) => events.filter((e) => e.type === 'tool_call').map((e) => e.payload.tool ?? e.payload.name);

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
    execFileSync('expect', [exp], { cwd: dir, env, timeout: (waitS + 60) * 1000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    /* expect's eof handling can exit non-zero; the assertions check the real outcome */
  }
}

// ── Scenario runner ──────────────────────────────────────────────────────────
const results = [];
async function scenario(name, fn) {
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

await scenario('patch + apply — generates a real diff and applies it', () => {
  const dir = freshRepo();
  const { out } = exc(dir, ['patch', 'Add a multiply(a, b) function to src/math.ts', '--yes']);
  const id = /patch_\d{8}_\d{6}/.exec(out)?.[0];
  assert(id, 'a patch id should be printed');
  const diff = readFileSync(join(dir, '.excalibur/patches', id, 'diff.patch'), 'utf8');
  assert(/multiply/.test(diff) && /^\+/m.test(diff), 'diff must add multiply');
  exc(dir, ['apply', id, '--yes']);
  assert(/multiply/.test(readFileSync(join(dir, 'src/math.ts'), 'utf8')), 'applied file must contain multiply');
});

await scenario('run — CREATES a new file', () => {
  const dir = freshRepo();
  exc(dir, ['run', 'Create a new file hello.txt containing exactly the text HELLO', '--yes']);
  assert(existsSync(join(dir, 'hello.txt')), 'hello.txt must exist');
  assert(/HELLO/.test(readFileSync(join(dir, 'hello.txt'), 'utf8')), 'hello.txt must contain HELLO');
  assert(toolsUsed(runEvents(dir)).includes('write_file'), 'should have used write_file');
});

await scenario('run — UPDATES an existing file', () => {
  const dir = freshRepo();
  exc(dir, ['run', 'Add a subtract(a, b) function to src/math.ts that returns a - b', '--yes']);
  const math = readFileSync(join(dir, 'src/math.ts'), 'utf8');
  assert(/subtract/.test(math) && /add/.test(math), 'math.ts must keep add and gain subtract');
});

await scenario('run — runs a BASH command / script and DELETES a file', () => {
  const dir = freshRepo({ 'doomed.txt': 'delete me\n' });
  exc(dir, ['run', 'Delete the file doomed.txt using a shell command', '--yes']);
  assert(!existsSync(join(dir, 'doomed.txt')), 'doomed.txt must be deleted');
  assert(toolsUsed(runEvents(dir)).includes('run_command'), 'should have used run_command');
});

await scenario('run — multi-step task drives the Todo band (task_update)', () => {
  const dir = freshRepo();
  exc(dir, ['run', 'In src/math.ts add input validation to add(), add a multiply() function, and add a JSDoc comment to each function', '--yes']);
  const events = runEvents(dir);
  assert(events.some((e) => e.type === 'task_update'), 'a multi-step run should emit task_update');
});

await scenario('review --diff — reviews local changes', () => {
  const dir = freshRepo();
  writeFileSync(join(dir, 'src/math.ts'), 'export function add(a, b) {\n  return a - b; // BUG\n}\n');
  const { out } = exc(dir, ['review', '--diff']);
  assert(out.replace(/\s+/g, ' ').length > 40, 'review should produce feedback');
});

await scenario('swarm — fans out independent subtasks', () => {
  const dir = freshRepo();
  const { out } = exc(dir, ['swarm', 'Create three independent files: AUTHORS with a name, a .editorconfig with basic settings, and a CONTRIBUTING.md with one line', '--yes', '--apply'], 240000);
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
  assert(out.includes('\x1b[?2026h'), 'live frames must be wrapped in DEC 2026 synchronized output');
});

await scenario('discovery — clarifies an idea with deterministic scoring', () => {
  const dir = freshRepo();
  const { out } = exc(dir, ['discovery', 'Add AI contract-renewal reminders', '--yes']);
  assert(/recommend|build|discovery|score/i.test(out), 'discovery should produce a recommendation/score');
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
  exc(dir, ['run', 'Create a shell script greet.sh that prints GREETINGS, make it executable, and run it', '--yes']);
  assert(existsSync(join(dir, 'greet.sh')), 'greet.sh must be created');
  assert(toolsUsed(runEvents(dir)).includes('run_command'), 'should have executed the script via run_command');
});

await scenario('branch — applies a patch onto a new git branch', () => {
  const dir = freshRepo();
  const { out } = exc(dir, ['patch', 'Add a multiply(a, b) function to src/math.ts', '--yes']);
  const id = /patch_\d{8}_\d{6}/.exec(out)?.[0];
  assert(id, 'a patch id should be printed');
  const res = exc(dir, ['branch', id, '--yes']);
  const branches = execFileSync('git', ['branch'], { cwd: dir, encoding: 'utf8' });
  assert(/excalibur\//.test(branches), `an excalibur/* branch must be created (got: ${branches.trim()})`);
});

await scenario('undo — reverts a run’s changes', () => {
  const dir = freshRepo();
  exc(dir, ['run', 'Create a file undome.txt containing UNDO', '--yes']);
  assert(existsSync(join(dir, 'undome.txt')), 'precondition: the run created undome.txt');
  const runId = execFileSync('ls', ['-t', join(dir, '.excalibur/runs')]).toString().trim().split('\n')[0];
  exc(dir, ['undo', runId, '--yes']);
  assert(!existsSync(join(dir, 'undome.txt')), 'undo must remove the file the run created');
});

await scenario('changes — lists a run’s changed files', () => {
  const dir = freshRepo();
  exc(dir, ['run', 'Add a divide(a, b) function to src/math.ts', '--yes']);
  const runId = execFileSync('ls', ['-t', join(dir, '.excalibur/runs')]).toString().trim().split('\n')[0];
  const { out } = exc(dir, ['changes', runId]);
  assert(/math\.ts/.test(out), 'changes should list the modified file');
});

await scenario('fork — forks a run from a step', () => {
  const dir = freshRepo();
  exc(dir, ['run', 'Create a file base.txt containing BASE', '--yes']);
  const runId = execFileSync('ls', ['-t', join(dir, '.excalibur/runs')]).toString().trim().split('\n')[0];
  const { out, code } = exc(dir, ['fork', runId, 'Also create forked.txt containing FORKED', '--yes']);
  assert(code === 0 && /fork|run_\d{8}/i.test(out), 'fork should produce a new run from the cached prefix');
});

await scenario('weekly-plan — generates a real report', () => {
  const dir = freshRepo();
  exc(dir, ['run', 'Create a file z.txt containing Z', '--yes']);
  const { out } = exc(dir, ['weekly-plan']);
  assert(/Weekly Plan|Last week|Plan for next week/i.test(out), 'weekly-plan should produce a report');
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
  assert(existsSync(join(dir, 'shellmade.txt')), 'the interactive shell should have created the file under auto-mode');
  assert(/SHELLMADE/.test(readFileSync(join(dir, 'shellmade.txt'), 'utf8')), 'the file should contain the requested content');
  // …and the auto-accept answer must be PERSISTED so future sessions never re-ask.
  const cfg = readFileSync(join(dir, '.excalibur/config.yaml'), 'utf8');
  assert(/auto:\s*true/.test(cfg), 'auto-accept must be persisted to .excalibur/config.yaml');
});

// ── Summary ───────────────────────────────────────────────────────────────────
for (const dir of tmpRepos) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
const passed = results.filter((r) => r.ok).length;
console.log(`\n── verify:real — ${passed}/${results.length} passed (Kimi) ──`);
for (const r of results.filter((r) => !r.ok)) console.log(`  ✗ ${r.name}: ${r.err}`);
process.exit(passed === results.length ? 0 : 1);
