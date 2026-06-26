#!/usr/bin/env node
/**
 * REAL-Kimi smoke for the AO9 scope engine as the mission `understand` step now
 * drives it: scopeTask (decompose → fan out read-only explorers → synthesize) →
 * ScopeMap, with classify + explore backed by REAL Kimi over THIS repo. Confirms
 * the wired engine produces a usable map (subsystems · built-vs-missing · risks)
 * and that scopeMapToMarkdown renders it — the shape mission-run reads.
 *
 * GATED: exits 0 (SKIP) without a Moonshot key. Run:
 *   MOONSHOT_API_KEY="$(cat ~/.config/excalibur/moonshot.key)" node scripts/verify-scope-engine.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  scopeTask,
  scopeMapToMarkdown,
  buildScopeExplorePrompt,
  parseScopeFragment,
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
  console.log('⚠ verify-scope-engine SKIPPED — no Kimi/Moonshot key.');
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

// A small REAL repo context so explorers ground in actual files (mirrors how
// computeScope feeds buildRepoContextSources, minimized for the probe).
const fileList = execFileSync('git', ['ls-files'], { cwd: process.cwd(), encoding: 'utf8' })
  .split('\n')
  .filter((f) => /interrupt|scope|mission|fleet/i.test(f))
  .slice(0, 30)
  .join('\n');

// classify drives decompose + synthesize (generous budget — the JSON is the larger shape).
const classify = (prompt) => kimi(prompt, 1024);
// explore runs one read-only angle → a fragment, grounded in the file list.
const explore = async (task, angle) => {
  const prompt = `${buildScopeExplorePrompt(task, angle)}\n\nRepository files (for grounding):\n${fileList}`;
  return parseScopeFragment(await kimi(prompt, 1024), angle.subsystem);
};

const TASK =
  'add a circuit-breaker around the model gateway calls so a failing provider degrades gracefully';
console.log(`\n  scope-engine smoke · "${TASK.slice(0, 56)}…" vs ${MODEL}\n`);

const map = await scopeTask(TASK, { classify, explore, complexity: 'medium' });

const failures = [];
if (map === null) {
  failures.push('scopeTask returned null (no map produced)');
} else {
  console.log(`  summary: ${map.summary.slice(0, 120)}`);
  console.log(`  subsystems (${map.subsystems.length}):`);
  for (const s of map.subsystems) {
    console.log(`    • ${s.subsystem} — missing: ${(s.whatsMissing || '(none)').slice(0, 70)}`);
  }
  console.log(`  risks: ${map.risks.length} · openQuestions: ${map.openQuestions.length}`);
  // Assertions: a usable map with at least one grounded subsystem + the markdown renders.
  if (map.subsystems.length === 0) failures.push('no subsystems in the map');
  const md = scopeMapToMarkdown(map);
  if (typeof md !== 'string' || md.length < 20)
    failures.push('scopeMapToMarkdown produced nothing');
  // Shape the mission render + threading rely on:
  for (const s of map.subsystems) {
    if (typeof s.subsystem !== 'string') failures.push('subsystem missing .subsystem');
    if (typeof s.whatsMissing !== 'string') failures.push('subsystem missing .whatsMissing');
  }
  console.log(`\n  scopeMapToMarkdown: ${md.length} chars rendered`);
}

if (failures.length > 0) {
  console.log('\n  FAILURES:');
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log('\n  ✓ scope engine produced a usable ScopeMap over real files vs real Kimi\n');
