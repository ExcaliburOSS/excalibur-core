#!/usr/bin/env node
/**
 * CALIBRATION harness for the interruption brain (INT-1..4) against REAL Kimi.
 * Drives the WIRED decision path — `decideInterrupt` (buildInterruptPrompt →
 * parseInterruptDecision → buildIndependencePrompt → parseIndependence →
 * planInterrupt) — exactly as the REPL does, and asserts, multi-language, that a
 * message typed mid-run routes to the right ACTION (fold/answer_inline/parallel/
 * pause_switch/abort/feed_answer).
 *
 * GATED: exits 0 (SKIP) when no Moonshot key is present. Run:
 *   MOONSHOT_API_KEY="$(cat ~/.config/excalibur/moonshot.key)" node scripts/verify-interrupt-routing.mjs
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decideInterrupt } from '../packages/core/dist/index.mjs';

const KEY_FILE = join(homedir(), '.config/excalibur/moonshot.key');
let KEY = process.env.MOONSHOT_API_KEY ?? '';
if (!KEY) {
  try {
    KEY = readFileSync(KEY_FILE, 'utf8').trim();
  } catch {
    /* none */
  }
}
if (!KEY) {
  console.log('⚠ verify-interrupt-routing SKIPPED — no Kimi/Moonshot key.');
  process.exit(0);
}

const BASE = 'https://api.moonshot.ai/v1';
const MODEL = 'kimi-k2.7-code';
// kimi-k2.7-code is a REASONING model: at production's fast tiny-token budget it would
// spend everything thinking and emit empty content, so (as in verify-scope-routing.mjs)
// drive it with reasoning_effort:'low' + a small budget so it emits the answer word. This
// verifies the PROMPT + PARSER + ROUTER against the real verify model; production triage
// uses a separate fast model. (temperature OMITTED — Kimi allows only the default.)
const MAXTOKENS = 256;

/** The injected InterruptModel — same shape the REPL's buildInterruptModel produces. */
const model = async (prompt) => {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: MAXTOKENS,
      reasoning_effort: 'low',
    }),
  });
  if (!res.ok) throw new Error(`Kimi ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
};

const BUSY = {
  currentWork: 'refactoring the rate limiter in src/api/limiter.ts',
  awaitingAnswer: false,
  touchedPaths: ['src/api/limiter.ts', 'src/api/refill.ts'],
};
const ASKING = {
  currentWork: 'refactoring the rate limiter in src/api/limiter.ts',
  awaitingAnswer: true,
  pendingQuestion: 'Approve writing src/api/limiter.ts?',
  touchedPaths: ['src/api/limiter.ts'],
};

// Each row asserts EITHER a final `action` (deterministic triage → route) OR, for
// genuinely-new work, only the `cls` (the parallel-vs-pause split is the
// independence judge's call — safe-by-default to pause, and under a verbose
// REASONING model used as the fast model it is intentionally conservative; the
// production fast model emits a clean verdict). This keeps the HARD gate on the
// triage classifier and treats the independence verdict as informational.
const MATRIX = [
  // steer → fold (a correction/addition to the SAME work)
  { input: 'actually, also handle the case where the window is zero', ctx: BUSY, action: 'fold' },
  {
    input: 'espera, mejor usa un Map en lugar de un array para los contadores',
    ctx: BUSY,
    action: 'fold',
  },
  // quick → answer_inline (a quick question, do not derail)
  { input: 'how much longer is this going to take?', ctx: BUSY, action: 'answer_inline' },
  { input: '¿qué archivo estás tocando ahora mismo?', ctx: BUSY, action: 'answer_inline' },
  // new work → classified as new (then routed parallel|pause_switch by independence)
  { input: 'separately, set up a GitHub Actions release workflow', ctx: BUSY, cls: 'new' },
  { input: 'aparte, crea una página de marketing nueva para el producto', ctx: BUSY, cls: 'new' },
  // stop → abort
  { input: "stop, that's the wrong approach", ctx: BUSY, action: 'abort' },
  { input: 'para, cancela eso', ctx: BUSY, action: 'abort' },
  // answer (while awaiting) → feed_answer
  { input: 'yes, go ahead and overwrite it', ctx: ASKING, action: 'feed_answer' },
  { input: 'sí, adelante', ctx: ASKING, action: 'feed_answer' },
];

let pass = 0;
const failures = [];
console.log(`\n  interrupt-routing calibration · ${MATRIX.length} inputs vs ${MODEL}\n`);

for (const row of MATRIX) {
  try {
    const out = await decideInterrupt(row.input, row.ctx, model);
    const action = out.plan.action;
    const want = row.action ?? `cls:${row.cls}`;
    const ok = row.action !== undefined ? action === row.action : out.decision.cls === row.cls;
    console.log(
      `  ${ok ? '✓' : '✗'} [want ${want}] → ${action} (${out.decision.cls}/${out.decision.confidence}` +
        `${out.independence ? `, indep=${out.independence.independent}` : ''})  "${row.input.slice(0, 48)}"`,
    );
    if (ok) pass += 1;
    else failures.push(`${row.input} → ${action} (${out.decision.cls}, wanted ${want})`);
  } catch (err) {
    failures.push(`${row.input} → ERROR ${err.message}`);
    console.log(`  ✗ ERROR  "${row.input.slice(0, 48)}" — ${err.message}`);
  }
}

console.log(`\n  ${pass}/${MATRIX.length} routed correctly\n`);
if (failures.length > 0) {
  console.log('  failures:');
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
