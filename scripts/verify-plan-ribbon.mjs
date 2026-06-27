#!/usr/bin/env node
/**
 * REAL-Kimi smoke for the PLAN4 live plan ribbon: a REAL multi-phase plan from
 * Kimi → the REAL `parsePlanMarkdown` (core) → the REAL `renderPlanRibbon` /
 * `planProgress` (tui), simulating the step-by-step progression that
 * `driveStructuredPlan` drives (each step active → done) and asserting the live
 * tree advances: the active node walks the plan, `done/total` rises, and the final
 * frame is all-✓. Because ONE model drives both the Ink `<PlanRibbon>` and this
 * string twin (live == replay), verifying the model + pure renderer on Kimi's
 * actual plan prose verifies what the TTY ribbon shows.
 *
 * GATED: exits 0 (SKIP) without a Moonshot key. Run:
 *   MOONSHOT_API_KEY="$(cat ~/.config/excalibur/moonshot.key)" node scripts/verify-plan-ribbon.mjs
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parsePlanMarkdown, planProgress, nextPendingStep } from '../packages/core/dist/index.mjs';
import { renderPlanRibbon } from '../packages/tui/dist/rail.js';

let KEY = process.env.MOONSHOT_API_KEY ?? '';
if (!KEY) {
  try {
    KEY = readFileSync(join(homedir(), '.config/excalibur/moonshot.key'), 'utf8').trim();
  } catch {
    /* none */
  }
}
if (!KEY) {
  console.log('⚠ verify-plan-ribbon SKIPPED — no Kimi/Moonshot key.');
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

/** The CLI's `planToRibbon` projection (a trivial 1:1 map — replicated here so the
 * script verifies the SAME shape `driveStructuredPlan` feeds the live ribbon). */
function planToRibbon(plan, task, outcome) {
  const { total, done } = planProgress(plan);
  return {
    task,
    done,
    total,
    outcome,
    phases: plan.phases.map((p) => ({
      id: p.id,
      title: p.title,
      steps: p.steps.map((s) => ({ id: s.id, title: s.title, status: s.status })),
    })),
  };
}

const fail = (msg) => {
  console.error(`\n  ✗ FAIL: ${msg}\n`);
  process.exit(1);
};

const TASK =
  'Add OAuth2 login (Google + GitHub) to a Node/Express app: config, provider flows, session handling, and tests';

console.log(`\n  plan-ribbon smoke · "${TASK.slice(0, 56)}…" vs ${MODEL}\n`);

// A multi-PHASE plan is exactly when the ribbon activates (the step-by-step gate).
const prompt =
  `Produce a concise implementation plan for the task below. Structure it as 2–4 PHASES ` +
  `(markdown "## " headings), each with a few numbered steps. Output ONLY the plan markdown.\n\nTask: ${TASK}`;
const md = await kimi(prompt, 1500); // generous budget — a full plan, not a classifier reply
if (md.trim().length === 0) fail('Kimi returned an empty plan');

// REAL parse — the same function driveStructuredPlan parses the planner output with.
const plan = parsePlanMarkdown(md);
const total = planProgress(plan).total;
console.log(`  parsed: ${plan.phases.length} phase(s), ${total} step(s)`);
if (plan.phases.length < 1 || total < 2) {
  fail(`expected a real multi-step plan, got ${plan.phases.length} phase(s) / ${total} step(s)`);
}

// Frame 0: nothing started — every step pending, 0 done.
const start = planToRibbon(plan, TASK, 'executing');
if (start.done !== 0) fail('initial ribbon should have 0 done steps');
const startLines = renderPlanRibbon(start, { tier: 'truecolor', spinnerFrame: 0 });
if (!startLines[0].includes('Plan:')) fail('ribbon header missing "Plan:"');
console.log('\n  ── frame 0 (nothing started) ──');
for (const l of renderPlanRibbon(start)) console.log('  ' + l);

// Walk the plan step by step exactly as runStructuredPlan does (active → done),
// re-projecting + rendering each transition and asserting the tree advances.
const flat = plan.phases.flatMap((p) => p.steps);
let prevDone = -1;
let frame = 0;
for (let i = 0; i < flat.length; i += 1) {
  flat[i].status = 'active';
  const activeModel = planToRibbon(plan, TASK, 'executing');
  const at = nextPendingStep(plan); // the active step is the next non-done one
  if (at?.step.id !== flat[i].id)
    fail(`nextPendingStep should point at the active step ${flat[i].id}`);
  const activeLines = renderPlanRibbon(activeModel, { tier: 'truecolor', spinnerFrame: frame++ });
  if (activeLines.join('\n').length === 0) fail('active-frame render was empty');

  flat[i].status = 'done';
  const doneModel = planToRibbon(plan, TASK, i === flat.length - 1 ? 'completed' : 'executing');
  if (doneModel.done <= prevDone) fail('done count did not advance after a step finished');
  prevDone = doneModel.done;
}

// Final frame: every step done, done === total, all ✓.
const finalModel = planToRibbon(plan, TASK, 'completed');
if (finalModel.done !== finalModel.total) {
  fail(`final ribbon should be fully done (${finalModel.done}/${finalModel.total})`);
}
const finalLines = renderPlanRibbon(finalModel);
console.log('\n  ── final frame (all done) ──');
for (const l of finalLines) console.log('  ' + l);
if (!finalLines.some((l) => l.includes('✓'))) fail('final ribbon should show ✓ on completed steps');
if (!finalLines[0].includes(`${finalModel.total}/${finalModel.total}`)) {
  fail('final header should show total/total');
}

console.log(
  `\n  ✓ PASS — Kimi plan (${plan.phases.length} phases / ${total} steps) renders + advances cleanly\n`,
);
