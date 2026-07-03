#!/usr/bin/env node
/**
 * G5 verification — the DETERMINISTIC self-review backstop fires on a NON-trivial
 * mutating turn even when the repo has NO test command (the exact gate that used
 * to suppress it). Asserts the adversarial-review banner appears after the build.
 *
 * Real Kimi. A non-trivial multi-symbol change so the proportional mesh sizes ≥1
 * lens (a 3-line change is correctly skipped by the mesh — not what we test here).
 */
/* eslint-disable no-control-regex, no-empty -- a throwaway pty verification harness: it strips ANSI (control chars) and best-effort-reads optional files. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CORE = '/Users/rafaelcasusoromate/excalibur-core';
const repo = mkdtempSync(join(tmpdir(), 'g5-'));
const sh = (c, a) => execFileSync(c, a, { cwd: repo, stdio: 'pipe' });
sh('git', ['init', '-q']);
mkdirSync(join(repo, '.excalibur/models'), { recursive: true });
mkdirSync(join(repo, 'src'), { recursive: true });
// NOTE: deliberately NO `commands.test` — this is the gate that used to suppress review.
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
console.log('REPO=' + repo);

const task =
  'create src/auth.js exporting login(user, pass) and hashPassword(pass) using node crypto, with input validation';
const exp = `
set timeout 400
spawn node ${CORE}/apps/cli/dist/main.js
expect { -re "(build or fix|construir|›|>)" { } timeout { puts "NO_PROMPT"; exit 1 } }
sleep 1
send -- "${task}\\r"
# wait for the WHOLE turn to settle: the review runs at the very end, then the idle prompt returns
expect { -re "(Adversarial review|Revisión adversarial)" { puts "\\n>>>REVIEW_FIRED<<<" } timeout { puts "\\n>>>REVIEW_TIMEOUT<<<" } }
sleep 5
send -- "/exit\\r"
sleep 2
exit 0
`;
const expPath = join(repo, 'g5.exp');
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
    timeout: 460000,
  });
} catch (e) {
  log = (e.stdout || '') + (e.stderr || '');
}
const plain = log.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
let created = false;
try {
  created = readFileSync(join(repo, 'src/auth.js'), 'utf8').length > 0;
} catch {}
const reviewFired = /Adversarial review|Revisión adversarial/.test(plain);
const healFired = /review flagged|marcó la revisión|Corrigiendo lo que/.test(plain);
console.log('--- G5 verdict ---');
console.log('src/auth.js created (turn mutated):', created);
console.log('review banner fired:', reviewFired);
console.log('review-heal (fix pass) fired:', healFired);
console.log(
  reviewFired
    ? '\n>>> G5 PASS (deterministic review fired w/o a test command) <<<'
    : '\n>>> G5 NEEDS REVIEW <<<',
);
