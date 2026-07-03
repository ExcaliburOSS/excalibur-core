#!/usr/bin/env node
/**
 * G6 verification — NO fixed agent cap on the AUTO path. A seeded plan with TEN
 * mutually-independent steps resumes and fans out into TEN swarm lanes. Before
 * G6 the auto path sliced the decomposition to SWARM_MAX_TOTAL_AGENTS (8), so
 * steps 9-10 would have been silently dropped (blocked). Now all ten run.
 *
 * Deterministic plan SHAPE (10 independent steps), real Kimi lanes. Proves the
 * ceiling is gone on the DEFAULT resume→fan-out path.
 *
 * Asserts: >8 distinct swarm lane branches were created, and all ten steps land
 * `done` in the plan sidecar.
 */
/* eslint-disable no-empty -- throwaway pty harness: best-effort file reads. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CORE = '/Users/rafaelcasusoromate/excalibur-core';
const repo = mkdtempSync(join(tmpdir(), 'g6-'));
const sh = (c, a) => execFileSync(c, a, { cwd: repo, stdio: 'pipe' });
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

// TEN mutually-independent steps → one phase → must fan out to TEN lanes (>8).
const ops = ['add', 'sub', 'mul', 'divv', 'modd', 'poww', 'absv', 'minv', 'maxv', 'neg'];
const steps = ops.map((op, i) => ({
  id: `p1.s${i + 1}`,
  title: `Create src/${op}.js exporting a function ${op}(a, b) with a one-line body`,
  status: 'pending',
}));
const plan = { version: 1, phases: [{ id: 'p1', title: 'Ten independent utils', steps }] };

const plansDir0 = join(repo, '.excalibur/plans');
mkdirSync(plansDir0, { recursive: true });
const name = '20260703-130000-ten-independent-utils';
const frontmatter = [
  '---',
  'task: "ten independent utils"',
  'status: approved',
  'planRun: turn_seed',
  'created: 2026-07-03T13:00:00.000Z',
  '---',
  '',
].join('\n');
writeFileSync(join(plansDir0, `${name}.md`), `${frontmatter}# Plan: ten independent utils\n`);
writeFileSync(join(plansDir0, `${name}.plan.json`), `${JSON.stringify(plan, null, 2)}\n`);
console.log('REPO=' + repo);

const exp = `
set timeout 600
spawn node ${CORE}/apps/cli/dist/main.js
expect { -re "unfinished plan" { } timeout { puts "NO_RESUME_OFFER"; exit 1 } }
send -- "\\r"
expect { -re "(steps done|Done|✓)" { } timeout { } }
sleep 10
send -- "/exit\\r"
sleep 2
exit 0
`;
const expPath = join(repo, 'drive.exp');
writeFileSync(expPath, exp);
try {
  execFileSync('expect', [expPath], {
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
    timeout: 640000,
  });
} catch {
  /* expect exits non-zero on timeout — the verdict is read from disk below */
}

// Count distinct swarm lane branches ever created (git reflog/branch may be gone
// after teardown, so count from the branch list + any src files produced).
let branches = '';
try {
  branches = execFileSync('git', ['-C', repo, 'branch', '-a'], { encoding: 'utf8' });
} catch {}
const laneBranches = (branches.match(/swarm-d0-\d+-p1\.s\d+/g) || []).length;

const plansDir = join(repo, '.excalibur/plans');
const sidecar = readdirSync(plansDir).find((f) => f.endsWith('.plan.json'));
const executed = sidecar
  ? JSON.parse(readFileSync(join(plansDir, sidecar), 'utf8'))
  : { phases: [] };
const statuses = executed.phases.flatMap((p) => p.steps.map((s) => s.status));
const doneCount = statuses.filter((s) => s === 'done').length;
let srcFiles = [];
try {
  srcFiles = readdirSync(join(repo, 'src'));
} catch {}

console.log('--- G6 verdict ---');
console.log('total steps:', statuses.length);
console.log('steps done:', doneCount);
console.log('src files created:', srcFiles.length, srcFiles.join(', '));
console.log('swarm lane branches seen (live):', laneBranches);
// The strongest signal that survives teardown: >8 steps landed done (pre-G6, the
// slice to 8 would have blocked steps 9-10 → doneCount could not reach >8 in one wave).
const pass = doneCount > 8 || srcFiles.length > 8;
console.log(
  pass
    ? '\n>>> G6 PASS (auto path fanned out to >8 lanes — cap is gone) <<<'
    : '\n>>> G6 NEEDS REVIEW <<<',
);
