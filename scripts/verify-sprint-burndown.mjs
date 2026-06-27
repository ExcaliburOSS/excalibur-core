#!/usr/bin/env node
/**
 * REAL-Kimi smoke for PLAN5 chained on PLAN2: a REAL multi-phase plan from Kimi →
 * materialize into work-items (PLAN2) → estimate + assign every sub-task to a SPRINT
 * → complete some → computeBurndown over the sprint window. Asserts the points
 * roll-up and the day-by-day burndown series are correct on real model-derived
 * work-items, all persisted via the REAL SprintStore + LocalWorkItemProvider.
 *
 * GATED: exits 0 (SKIP) without a Moonshot key. Run:
 *   MOONSHOT_API_KEY="$(cat ~/.config/excalibur/moonshot.key)" node scripts/verify-sprint-burndown.mjs
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parsePlanMarkdown,
  planProgress,
  materializePlanWorkItems,
  SprintStore,
  computeBurndown,
} from '../packages/core/dist/index.mjs';
import { LocalWorkItemProvider, laneOf } from '../packages/work-items/dist/index.mjs';

let KEY = process.env.MOONSHOT_API_KEY ?? '';
if (!KEY) {
  try {
    KEY = readFileSync(join(homedir(), '.config/excalibur/moonshot.key'), 'utf8').trim();
  } catch {
    /* none */
  }
}
if (!KEY) {
  console.log('⚠ verify-sprint-burndown SKIPPED — no Kimi/Moonshot key.');
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

const TASK = 'Build a webhook delivery service: queue, retry policy, signing, and a dashboard';
console.log(`\n  sprint+burndown smoke · "${TASK.slice(0, 48)}…" vs ${MODEL}\n`);

const prompt =
  `Produce a concise implementation plan for the task below as 2–4 PHASES ("## " headings), ` +
  `each with a few numbered steps. Output ONLY the plan markdown.\n\nTask: ${TASK}`;
const plan = parsePlanMarkdown(await kimi(prompt, 1500));
const total = planProgress(plan).total;
console.log(`  parsed: ${plan.phases.length} phase(s), ${total} step(s)`);
if (total < 2) fail(`expected a real multi-step plan, got ${total} step(s)`);

const repo = mkdtempSync(join(tmpdir(), 'excalibur-plan5-'));
try {
  // PLAN2 — materialize the real plan into work-items (default clock).
  const creator = new LocalWorkItemProvider(repo);
  const result = materializePlanWorkItems(
    plan,
    {
      createWorkItem: (input) => creator.createWorkItem(input),
      setBlockedBy: (key, blockedBy) => creator.updateWorkItem(key, { blockedBy }),
    },
    { task: TASK },
  );
  const stepKeys = Object.values(result.stepWorkItemIds);
  if (stepKeys.length !== total) fail('materialized step count mismatch');

  // PLAN5 — a sprint window with a fixed-clock provider so completion dates are
  // deterministic (mid-window). Estimate every sub-task; complete the first half.
  const SPRINT_START = '2026-07-01';
  const SPRINT_END = '2026-07-05';
  const DONE_DATE = '2026-07-03';
  const fixed = new LocalWorkItemProvider(repo, { now: () => new Date(`${DONE_DATE}T09:00:00Z`) });
  const sprint = new SprintStore(repo).createSprint({
    name: 'Sprint 1',
    goal: TASK,
    startDate: SPRINT_START,
    endDate: SPRINT_END,
  });

  const POINTS = 3;
  const halfDone = Math.floor(stepKeys.length / 2);
  stepKeys.forEach((key, i) => {
    fixed.updateWorkItem(key, { estimate: POINTS, cycleOrSprint: sprint.id });
    if (i < halfDone) fixed.updateWorkItem(key, { status: 'done' });
  });

  // Project the sprint's work-items into burndown items (the same projection the
  // dashboard/CLI use) and compute the burndown over the window.
  const all = await fixed.listWorkItems({ integrationId: 'local' });
  const items = all
    .filter((w) => w.cycleOrSprint === sprint.id)
    .map((w) => ({
      points: w.estimate ?? 1,
      doneDate: laneOf(w.status) === 'done' ? (w.updatedAt ?? '').slice(0, 10) || null : null,
    }));
  const b = computeBurndown(SPRINT_START, SPRINT_END, items);

  const expectTotal = stepKeys.length * POINTS;
  const expectDone = halfDone * POINTS;
  if (b.totalPoints !== expectTotal) fail(`totalPoints ${b.totalPoints} ≠ ${expectTotal}`);
  if (b.donePoints !== expectDone) fail(`donePoints ${b.donePoints} ≠ ${expectDone}`);
  if (b.days.length !== 5) fail(`expected 5 burndown days, got ${b.days.length}`);
  if (b.days.at(-1).ideal !== 0) fail('ideal should reach 0 on the last day');
  // Remaining must DROP on the completion day (07-03) and stay there.
  const day1 = b.days.find((d) => d.date === '2026-07-01');
  const day3 = b.days.find((d) => d.date === DONE_DATE);
  if (day1.remaining !== expectTotal) fail(`day1 remaining ${day1.remaining} ≠ ${expectTotal}`);
  if (day3.remaining !== expectTotal - expectDone) {
    fail(`day3 remaining ${day3.remaining} ≠ ${expectTotal - expectDone}`);
  }

  console.log(
    `  sprint ${sprint.id} · ${items.length} items · ${b.donePoints}/${b.totalPoints} pts done`,
  );
  console.log(
    `  burndown remaining: ${b.days.map((d) => `${d.date.slice(5)}:${d.remaining}`).join('  ')}`,
  );
  console.log(
    `\n  ✓ PASS — Kimi plan → ${stepKeys.length} sub-tasks → sprint → burndown (${b.totalPoints}pt) verified\n`,
  );
} finally {
  rmSync(repo, { recursive: true, force: true });
}
