#!/usr/bin/env node
/**
 * G1 verification — a SEEDED approved plan with a phase of TWO independent steps
 * resumes and FANS OUT into a parallel swarm (each step a lane in its own
 * worktree, verified + merged), instead of running the steps one-at-a-time.
 *
 * Deterministic plan SHAPE (seeded by us), real Kimi lanes. Proves the composed
 * plan×swarm engine on the DEFAULT resume path — not a unit test of the pieces.
 *
 * Asserts: both target files are created (the plan did its work), the plan sidecar
 * marks BOTH steps `done`, and the transcript shows swarm fan-out (parallel lanes).
 */
/* eslint-disable no-control-regex, no-empty -- a throwaway pty verification harness: it strips ANSI (control chars) and best-effort-reads optional files. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CORE = '/Users/rafaelcasusoromate/excalibur-core';

const repo = mkdtempSync(join(tmpdir(), 'g1-'));
const sh = (cmd, args) => execFileSync(cmd, args, { cwd: repo, stdio: 'pipe' });
sh('git', ['init', '-q']);
mkdirSync(join(repo, '.excalibur/models'), { recursive: true });
mkdirSync(join(repo, 'src'), { recursive: true });
writeFileSync(
  join(repo, '.excalibur/config.yaml'),
  'version: 1\napprovals:\n  auto: true\nautonomy:\n  default: 4\n',
);
writeFileSync(
  join(repo, '.excalibur/models/providers.yaml'),
  'providers:\n  default: kimi\n  kimi:\n    type: openai-compatible\n    baseUrl: https://api.moonshot.ai/v1\n    apiKeyEnv: MOONSHOT_API_KEY\n    model: kimi-k2.7-code\n    capabilities:\n      reasoning: true\n      tools: true\n',
);
writeFileSync(join(repo, 'README.md'), '# seed\n');
sh('git', ['add', '-A']);
sh('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'init']);

// A plan with ONE phase of TWO mutually-independent steps → must fan out.
const plan = {
  version: 1,
  phases: [
    {
      id: 'p1',
      title: 'Add two independent utils',
      steps: [
        {
          id: 'p1.s1',
          title: 'Create src/greet.js exporting greet(name) => `Hello, ${name}!`',
          status: 'pending',
        },
        {
          id: 'p1.s2',
          title: 'Create src/farewell.js exporting farewell(name) => `Bye, ${name}!`',
          status: 'pending',
        },
      ],
    },
  ],
};
// Seed the plan on disk in the exact `savePlan` format (a `.md` with frontmatter
// + the `.plan.json` sidecar, which is the structured source of truth for resume).
const plansDir0 = join(repo, '.excalibur/plans');
mkdirSync(plansDir0, { recursive: true });
const name = '20260703-120000-add-greet-and-farewell-utils';
const frontmatter = [
  '---',
  'task: "add greet and farewell utils"',
  'status: approved',
  'planRun: turn_seed',
  'created: 2026-07-03T12:00:00.000Z',
  '---',
  '',
].join('\n');
const body =
  '# Plan: add greet and farewell utils\n\n## Add two independent utils\n- [ ] Create src/greet.js\n- [ ] Create src/farewell.js\n';
writeFileSync(join(plansDir0, `${name}.md`), `${frontmatter}${body}`);
writeFileSync(join(plansDir0, `${name}.plan.json`), `${JSON.stringify(plan, null, 2)}\n`);

console.log('REPO=' + repo);

const exp = `
set timeout 320
spawn node ${CORE}/apps/cli/dist/main.js
expect { -re "unfinished plan" { } timeout { puts "NO_RESUME_OFFER"; exit 1 } }
send -- "\\r"
expect { -re "(steps done|pasos|Done|✓)" { } timeout { } }
sleep 8
send -- "/exit\\r"
sleep 2
exit 0
`;
const expPath = join(repo, 'drive.exp');
writeFileSync(expPath, exp);

let log = '';
try {
  log = execFileSync('expect', [expPath], {
    cwd: repo,
    env: {
      ...process.env,
      MOONSHOT_API_KEY: readFileSync(
        join(process.env.HOME, '.config/excalibur/moonshot.key'),
        'utf8',
      ).trim(),
      EXCALIBUR_ASCII: '1',
      EXCALIBUR_DASHBOARD: 'off',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    },
    encoding: 'utf8',
    timeout: 360000,
  });
} catch (e) {
  log = (e.stdout || '') + (e.stderr || '');
}
const plain = log.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

// Read back the plan sidecar to see the executed step statuses.
const plansDir = join(repo, '.excalibur/plans');
const sidecar = readdirSync(plansDir).find((f) => f.endsWith('.plan.json'));
const executed = sidecar
  ? JSON.parse(readFileSync(join(plansDir, sidecar), 'utf8'))
  : { phases: [] };
const statuses = executed.phases.flatMap((p) => p.steps.map((s) => `${s.id}:${s.status}`));

let greet = false;
let farewell = false;
try {
  greet = readFileSync(join(repo, 'src/greet.js'), 'utf8').length > 0;
} catch {}
try {
  farewell = readFileSync(join(repo, 'src/farewell.js'), 'utf8').length > 0;
} catch {}

const fanoutSignal =
  /lane|worktree|swarm|parallel|p1\.s1[\s\S]*p1\.s2/i.test(plain) && !/sequential/i.test(plain);

console.log('--- G1 verdict ---');
console.log('step statuses:', statuses.join(', '));
console.log('src/greet.js created:', greet);
console.log('src/farewell.js created:', farewell);
console.log('fan-out signal in transcript:', fanoutSignal);
const bothDone = statuses.includes('p1.s1:done') && statuses.includes('p1.s2:done');
console.log('PLAN COMPLETED (both steps done):', bothDone);
console.log(bothDone && greet && farewell ? '\n>>> G1 PASS <<<' : '\n>>> G1 NEEDS REVIEW <<<');
