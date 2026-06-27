#!/usr/bin/env node
/**
 * REAL-Kimi smoke for PLAN7 (structured re-plan diff): generate TWO real plans from
 * Kimi — a task, then a REVISED task with an extra requirement — and diffPlans() them.
 * Verifies the title-based matcher RELATES the overlapping steps across two
 * independently-worded real plans (not "everything added + everything removed") and
 * surfaces the revision's new work — the real test of the fuzzy threshold.
 *
 * GATED: exits 0 (SKIP) without a Moonshot key. Run:
 *   MOONSHOT_API_KEY="$(cat ~/.config/excalibur/moonshot.key)" node scripts/verify-plan-diff.mjs
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  parsePlanMarkdown,
  renderPlanMarkdown,
  planProgress,
  diffPlans,
  renderPlanDiff,
} from '../packages/core/dist/index.mjs';

let KEY = process.env.MOONSHOT_API_KEY ?? '';
if (!KEY) {
  try {
    KEY = readFileSync(join(homedir(), '.config/excalibur/moonshot.key'), 'utf8').trim();
  } catch {
    /* none */
  }
}
if (!KEY) {
  console.log('⚠ verify-plan-diff SKIPPED — no Kimi/Moonshot key.');
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

const TASK = 'Add a file-upload endpoint: validation, storage, and tests';

console.log(`\n  plan-diff smoke · re-plan of "${TASK.slice(0, 40)}…" vs ${MODEL}\n`);

// Plan A: the original.
const planA = parsePlanMarkdown(
  await kimi(
    `Produce a concise implementation plan for the task below as 2–4 PHASES ("## " headings), ` +
      `each with a few numbered steps. Output ONLY the plan markdown.\n\nTask: ${TASK}`,
    1500,
  ),
);
// Plan B: a real RE-PLAN — Kimi AMENDS plan A for an extra requirement, keeping the
// existing steps (this mirrors the actual edit-and-re-plan flow `plans diff` targets).
const planB = parsePlanMarkdown(
  await kimi(
    `Here is the current implementation plan:\n\n${renderPlanMarkdown(planA)}\n\n` +
      `REVISE it to ALSO add virus scanning and a max upload-size limit. KEEP the existing ` +
      `steps verbatim where they still apply; only add/adjust what the new requirement needs. ` +
      `Output ONLY the revised plan markdown (same "## " phase + numbered-step format).`,
    1800,
  ),
);
const a = planProgress(planA).total;
const b = planProgress(planB).total;
console.log(`  plan A: ${a} steps · plan B (revised): ${b} steps`);
if (a < 2 || b < 2) fail('expected two real multi-step plans');

const diff = diffPlans(planA, planB);
console.log(`  diff summary:`, JSON.stringify(diff.summary));

if (diff.identical) fail('two different real plans should not diff as identical');
// The matcher must RELATE overlapping work across two independently-worded plans
// (validation/storage/tests appear in both) — not classify everything as add+remove.
const related = diff.summary.unchanged + diff.summary.renamed + diff.summary.moved;
if (related < 1) {
  fail(
    `fuzzy matcher related 0 steps — everything read as add/remove (${JSON.stringify(diff.summary)})`,
  );
}
// The revision (virus scanning / size limit) should surface as added work.
if (diff.summary.added < 1)
  fail('the revised plan added no steps — unexpected for an extra requirement');
const lines = renderPlanDiff(diff);
if (lines.length < 2 || !lines[0].includes('Plan changed')) fail('render produced no diff summary');

console.log('\n  ── rendered diff (first 10 lines) ──');
for (const l of lines.slice(0, 10)) console.log('  ' + l);
console.log(
  `\n  ✓ PASS — re-plan diff related ${related} step(s), surfaced ${diff.summary.added} added on real Kimi plans\n`,
);
