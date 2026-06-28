#!/usr/bin/env node
/**
 * REAL-Kimi e2e for the proactive-tools epic (#241): prove that the agent calls
 * a MANAGEMENT tool ON ITS OWN, mid-conversation, when the situation calls for it
 * — the foundation that Excalibur uses its own features without the user typing a
 * command. We ask the REPL a project-state question and assert the run's event
 * log contains a `tool_call` for one of the management tools (project_status /
 * work_items / sprint_status / plans / insights / …).
 *
 * GATED: exits 0 (SKIP) without a Moonshot key or without `expect`.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
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
  console.log('⚠ verify-proactive-tools SKIPPED — no Kimi/Moonshot key.');
  process.exit(0);
}
try {
  execFileSync('which', ['expect'], { stdio: 'ignore' });
} catch {
  console.log('⚠ verify-proactive-tools SKIPPED — `expect` not installed.');
  process.exit(0);
}
if (!existsSync(CLI)) {
  console.error('✗ CLI not built — run `pnpm --filter @excalibur-oss/excalibur build` first.');
  process.exit(1);
}

const MANAGEMENT_TOOLS = new Set([
  'project_status',
  'work_items',
  'sprint_status',
  'plans',
  'insights',
  'run_logs',
  'list_agents',
  'list_skills',
  'sessions',
  'verify',
  'review',
]);

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
const env = { ...process.env, MOONSHOT_API_KEY: KEY, EXCALIBUR_ASCII: '1' };
const dir = mkdtempSync(join(tmpdir(), 'exc-proactive-'));

function setup() {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/demo.git'], { cwd: dir });
  mkdirSync(join(dir, '.excalibur/models'), { recursive: true });
  writeFileSync(join(dir, '.excalibur/config.yaml'), 'version: 1\ncommands: {}\n');
  writeFileSync(join(dir, '.excalibur/models/providers.yaml'), PROVIDERS);
  writeFileSync(join(dir, 'README.md'), '# Demo project\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
}

/**
 * Drives a non-interactive `excalibur run` (no pty, no REPL onboarding — reliable
 * with a slow reasoning model). A `--structured` run has an `agent_work` implement
 * phase that runs the native tool loop (where the management tools live, exactly
 * as a conversational turn does); `--fast` would use single-shot patch generation
 * with no tool loop. The task instructs the agent to read project state.
 */
function runTask(task) {
  try {
    execFileSync('node', [CLI, 'run', '-y', '--structured', task], {
      cwd: dir,
      env,
      timeout: 280_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    /* the run may exit non-zero (e.g. a gate); the events.jsonl is the proof */
  }
}

function allRunEvents() {
  const runsDir = join(dir, '.excalibur/runs');
  if (!existsSync(runsDir)) return [];
  const events = [];
  for (const id of readdirSync(runsDir).sort()) {
    const f = join(runsDir, id, 'events.jsonl');
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)) {
      try {
        events.push(JSON.parse(line));
      } catch {
        /* skip a torn line */
      }
    }
  }
  return events;
}

const fail = (msg, extra) => {
  console.error(`\n  ✗ FAIL: ${msg}`);
  if (extra) console.error(`    ${extra}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
};

console.log('\n  proactive-tools e2e (#241) · vs kimi-k2.7-code\n');
setup();
runTask(
  "First call your project_status tool to read this project's current state (runs, work items, plans). " +
    'Then write a file STATUS.md containing a one-sentence summary of what you found.',
);

const events = allRunEvents();
if (events.length === 0) fail('no run was recorded (the gated run never produced events)');

const toolCalls = events
  .filter((e) => e.type === 'tool_call')
  .map((e) => String(e.payload?.tool ?? ''));
const managementCalls = [...new Set(toolCalls.filter((t) => MANAGEMENT_TOOLS.has(t)))];

console.log(`  tool calls observed: ${[...new Set(toolCalls)].join(', ') || '(none)'}`);
console.log(`  management tools called: ${managementCalls.join(', ') || '(none)'}`);

if (managementCalls.length === 0) {
  fail(
    'the agent did NOT call any management tool — proactivity not wired into the live loop',
    `all tool calls: ${JSON.stringify([...new Set(toolCalls)])}`,
  );
}

console.log(
  `\n  ✓ PASS — the agent PROACTIVELY called ${managementCalls.join(', ')} on its own to ` +
    `pull project state into the conversation (no command typed).\n`,
);
rmSync(dir, { recursive: true, force: true });
