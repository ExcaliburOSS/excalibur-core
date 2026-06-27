#!/usr/bin/env node
/**
 * REAL-Kimi smoke for PLAN6 (richer plan memory): a REAL multi-phase plan from Kimi
 * → parsePlanMarkdown → buildPlanMemoryEntry, with a REAL run (RunManager) emitting a
 * file_write event wired to a step. Asserts the memory entry summarizes the real
 * plan (outcome statement + phase/step rationale) AND derives subjectPaths from the
 * run's events — the relevance key the old thin capture lacked.
 *
 * GATED: exits 0 (SKIP) without a Moonshot key. Run:
 *   MOONSHOT_API_KEY="$(cat ~/.config/excalibur/moonshot.key)" node scripts/verify-plan-memory.mjs
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parsePlanMarkdown,
  planProgress,
  buildPlanMemoryEntry,
  RunManager,
} from '../packages/core/dist/index.mjs';
import { createEvent } from '../packages/shared/dist/index.mjs';

let KEY = process.env.MOONSHOT_API_KEY ?? '';
if (!KEY) {
  try {
    KEY = readFileSync(join(homedir(), '.config/excalibur/moonshot.key'), 'utf8').trim();
  } catch {
    /* none */
  }
}
if (!KEY) {
  console.log('⚠ verify-plan-memory SKIPPED — no Kimi/Moonshot key.');
  process.exit(0);
}

const BASE = 'https://api.moonshot.ai/v1';
const MODEL = 'kimi-k2.7-code';

async function kimi(prompt, maxTokens) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      reasoning_effort: 'low',
    }),
  });
  if (!res.ok) throw new Error(`Kimi ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}

const fail = (msg) => {
  console.error(`\n  ✗ FAIL: ${msg}\n`);
  process.exit(1);
};

const TASK = 'Add structured request logging with correlation ids';
console.log(`\n  plan-memory smoke · "${TASK}" vs ${MODEL}\n`);

const prompt =
  `Produce a concise implementation plan for the task below as 2–4 PHASES ("## " headings), ` +
  `each with a few numbered steps. Output ONLY the plan markdown.\n\nTask: ${TASK}`;
const plan = parsePlanMarkdown(await kimi(prompt, 1500));
const { total } = planProgress(plan);
console.log(`  parsed: ${plan.phases.length} phase(s), ${total} step(s)`);
if (total < 2) fail(`expected a real multi-step plan, got ${total} step(s)`);

const repo = mkdtempSync(join(tmpdir(), 'excalibur-plan6-'));
try {
  execFileSync('git', ['init', '-q'], { cwd: repo });

  // Mark the plan's steps done and wire a REAL run (with a file_write event) to the
  // first step, so buildPlanMemoryEntry can derive subjectPaths from its events.
  const manager = new RunManager(repo);
  const run = manager.createRun({ title: 'step run', autonomyLevel: 4, workflow: 'conversation' });
  const TOUCHED = 'src/logging/correlation.ts';
  manager.appendEvent(
    run.id,
    createEvent({ runId: run.id, type: 'file_write', payload: { ok: true, path: TOUCHED } }),
  );
  manager.updateRecord(run.id, { status: 'completed' });
  let first = true;
  for (const phase of plan.phases) {
    for (const step of phase.steps) {
      step.status = 'done';
      if (first) {
        step.runId = run.id;
        first = false;
      }
    }
  }

  const entry = buildPlanMemoryEntry(repo, plan, {
    task: TASK,
    planRunId: 'run_plan',
    completed: true,
  });

  if (entry.type !== 'decision') fail(`expected a decision node, got ${entry.type}`);
  if (!entry.statement.includes(TASK)) fail('statement omits the task');
  if (!entry.statement.includes(`${total} step`)) fail(`statement omits the ${total}-step count`);
  if (!entry.statement.includes(`${plan.phases.length} phase`))
    fail('statement omits the phase count');
  // The rationale carries the phase→step outline (the first real phase title).
  const phase0 = plan.phases[0]?.title ?? '';
  if (phase0.length > 0 && !entry.rationale.includes(phase0))
    fail('rationale omits the first phase');
  if (!entry.rationale.includes('✓')) fail('rationale omits done-step glyphs');
  // subjectPaths — the relevance key — must include the touched file from the run.
  if (!(entry.subjectPaths ?? []).includes(TOUCHED)) {
    fail(`subjectPaths ${JSON.stringify(entry.subjectPaths)} missing ${TOUCHED}`);
  }
  if (entry.confidence !== 0.8) fail(`completed-plan confidence ${entry.confidence} ≠ 0.8`);

  console.log(`  statement: ${entry.statement}`);
  console.log(`  subjectPaths: ${JSON.stringify(entry.subjectPaths)}`);
  console.log(`  rationale: ${entry.rationale.slice(0, 120)}…`);
  console.log(`\n  ✓ PASS — Kimi plan → rich memory (outcome + outline + subjectPaths) verified\n`);
} finally {
  rmSync(repo, { recursive: true, force: true });
}
