#!/usr/bin/env node
/**
 * REAL-Kimi smoke for PLAN2 (plan → work-items): a REAL multi-phase plan from Kimi
 * → the REAL `parsePlanMarkdown` (core) → the REAL `materializePlanWorkItems` (core)
 * driving a REAL `LocalWorkItemProvider` (work-items) into a temp repo. Asserts the
 * plan becomes an EPIC, each step a sub-task under it (parentExternalId), step deps
 * become `blockedBy` dependency edges, and every step links back via workItemId —
 * all persisted on disk. This is the exact path the CLI's plan-approval hook runs.
 *
 * GATED: exits 0 (SKIP) without a Moonshot key. Run:
 *   MOONSHOT_API_KEY="$(cat ~/.config/excalibur/moonshot.key)" node scripts/verify-plan-workitems.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parsePlanMarkdown,
  planProgress,
  materializePlanWorkItems,
} from '../packages/core/dist/index.mjs';
import { LocalWorkItemProvider } from '../packages/work-items/dist/index.mjs';

let KEY = process.env.MOONSHOT_API_KEY ?? '';
if (!KEY) {
  try {
    KEY = readFileSync(join(homedir(), '.config/excalibur/moonshot.key'), 'utf8').trim();
  } catch {
    /* none */
  }
}
if (!KEY) {
  console.log('⚠ verify-plan-workitems SKIPPED — no Kimi/Moonshot key.');
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

const TASK = 'Add a rate limiter to the public API: config, middleware, storage, and tests';
console.log(`\n  plan→work-items smoke · "${TASK.slice(0, 52)}…" vs ${MODEL}\n`);

const prompt =
  `Produce a concise implementation plan for the task below. Structure it as 2–4 PHASES ` +
  `("## " headings), each with a few numbered steps. Output ONLY the plan markdown.\n\nTask: ${TASK}`;
const md = await kimi(prompt, 1500);
const plan = parsePlanMarkdown(md);
const total = planProgress(plan).total;
console.log(`  parsed: ${plan.phases.length} phase(s), ${total} step(s)`);
if (total < 2) fail(`expected a real multi-step plan, got ${total} step(s)`);

// Seed deterministic cross-step deps so we exercise blockedBy: every step (after the
// first in its phase) depends on the previous step — a realistic sequential chain.
const flat = plan.phases.flatMap((p) => p.steps);
for (const phase of plan.phases) {
  for (let i = 1; i < phase.steps.length; i += 1) {
    phase.steps[i].deps = [phase.steps[i - 1].id];
  }
}

const repo = mkdtempSync(join(tmpdir(), 'excalibur-plan2-'));
try {
  const provider = new LocalWorkItemProvider(repo);
  const result = materializePlanWorkItems(
    plan,
    {
      createWorkItem: (input) => provider.createWorkItem(input),
      setBlockedBy: (key, blockedBy) => provider.updateWorkItem(key, { blockedBy }),
    },
    { task: TASK },
  );

  // 1 epic + one sub-task per step, all persisted.
  if (result.created !== total + 1)
    fail(`expected ${total + 1} work-items, created ${result.created}`);
  const epicKey = result.epicWorkItemId;
  if (epicKey === null) fail('no epic was created');

  // Read the board back FROM DISK and verify the hierarchy + dependency edges.
  const all = await provider.listWorkItems({ integrationId: 'local' });
  const epic = all.find((w) => w.key === epicKey);
  if (epic === undefined || epic.parentExternalId !== null) fail('epic missing or has a parent');
  const children = all.filter((w) => w.parentExternalId === epicKey);
  if (children.length !== total) fail(`expected ${total} sub-tasks, found ${children.length}`);

  // Every step linked back, and the sequential deps materialized as blockedBy.
  let depEdges = 0;
  for (const phase of plan.phases) {
    for (const step of phase.steps) {
      if (step.workItemId === undefined) fail(`step ${step.id} not linked to a work-item`);
      const wi = all.find((w) => w.key === step.workItemId);
      if (wi === undefined) fail(`work-item ${step.workItemId} missing on disk`);
      const deps = (step.deps ?? [])
        .map((d) => result.stepWorkItemIds[d])
        .filter((k) => k !== undefined);
      if (deps.length > 0) {
        depEdges += 1;
        const got = wi.blockedBy ?? [];
        if (JSON.stringify(got) !== JSON.stringify(deps)) {
          fail(`step ${step.id}: blockedBy ${JSON.stringify(got)} ≠ ${JSON.stringify(deps)}`);
        }
      }
    }
  }
  if (depEdges === 0) fail('no dependency edges were materialized');

  // Idempotency: re-materializing the linked plan creates nothing new.
  const again = materializePlanWorkItems(
    plan,
    {
      createWorkItem: (input) => provider.createWorkItem(input),
      setBlockedBy: (key, blockedBy) => provider.updateWorkItem(key, { blockedBy }),
    },
    { task: TASK },
  );
  if (again.created !== 0) fail(`re-materialize created ${again.created} (should be 0)`);

  console.log(`  epic ${epicKey} · ${children.length} sub-tasks · ${depEdges} dependency edge(s)`);
  console.log(
    `  sample: ${flat[1]?.workItemId} "${flat[1]?.title.slice(0, 40)}" blockedBy ${JSON.stringify(
      all.find((w) => w.key === flat[1]?.workItemId)?.blockedBy ?? [],
    )}`,
  );
  console.log(
    `\n  ✓ PASS — Kimi plan materialized into 1 epic + ${total} sub-tasks (idempotent, deps wired)\n`,
  );
} finally {
  rmSync(repo, { recursive: true, force: true });
}
