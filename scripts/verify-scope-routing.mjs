#!/usr/bin/env node
/**
 * CALIBRATION harness for AO9-3 NL-routed "Understand-first" scope (#213). Runs the
 * REAL decision prompt against REAL Kimi and asserts, multi-language, that:
 *   (1) "understand/evaluate this BEFORE building" requests route to `scope`, and
 *   (2) plain one-shot builds / questions do NOT route to `scope`.
 *
 * GATED: exits 0 (SKIP) when no Moonshot key is present. Run:
 *   MOONSHOT_API_KEY="$(cat ~/.config/excalibur/moonshot.key)" node scripts/verify-scope-routing.mjs
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildDecisionPrompt, parseTurnDecision } from '../packages/core/dist/index.mjs';

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
  console.log('⚠ verify-scope-routing SKIPPED — no Kimi/Moonshot key.');
  process.exit(0);
}

const BASE = 'https://api.moonshot.ai/v1';
const MODEL = 'kimi-k2.7-code';
// kimi-k2.7-code is a REASONING model: at production's fast 6-token intent budget it
// would spend everything thinking and emit empty content, so it cannot emulate the
// real fast intent model. As in verify-schedule-routing.mjs, drive the decision with a
// bounded reasoning_effort:'low' + a small budget so it can emit the answer word. This
// verifies the PROMPT + PARSER against the real verify model; production routing uses a
// separate fast model at 6 tokens. (temperature OMITTED — Kimi allows only the default.)
const DECISION_MAXTOKENS = 256;

async function ask(prompt) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: DECISION_MAXTOKENS,
      reasoning_effort: 'low',
    }),
  });
  if (!res.ok) throw new Error(`Kimi ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}

// Each row: a request and whether it should route to `scope`.
const MATRIX = [
  // --- SHOULD route to scope (understand/evaluate read-only, before building) ---
  { req: "what's involved in adding OAuth login to this service?", scope: true },
  { req: 'scope what it would take to migrate the API to GraphQL', scope: true },
  { req: 'which files and parts would I need to touch to add rate limiting?', scope: true },
  { req: 'analiza qué haría falta para añadir multi-factor auth al login', scope: true },
  { req: 'qué implica añadir soporte de pagos con Stripe a la app', scope: true },
  { req: "évalue ce qu'implique l'ajout du mode hors ligne avant de coder", scope: true },
  // --- should NOT route to scope (direct one-shot work / questions) ---
  { req: 'add a --version flag that prints the package version', scope: false },
  { req: 'rename the variable usr to user in auth.ts', scope: false },
  { req: 'run the test suite now', scope: false },
];

let pass = 0;
const failures = [];
console.log(`\n  scope-routing calibration · ${MATRIX.length} requests vs ${MODEL}\n`);

for (const row of MATRIX) {
  try {
    const decision = parseTurnDecision(await ask(buildDecisionPrompt(row.req)));
    const routedScope = decision.intent === 'scope';
    const ok = routedScope === row.scope;
    const want = row.scope ? 'scope' : 'NOT scope';
    console.log(
      `  ${ok ? '✓' : '✗'} [want ${want}] intent=${decision.intent} (${decision.confidence})  "${row.req.slice(0, 56)}"`,
    );
    if (ok) pass += 1;
    else failures.push(`${row.req} → ${decision.intent} (wanted ${want})`);
  } catch (err) {
    failures.push(`${row.req} → ERROR ${err.message}`);
    console.log(`  ✗ ERROR  "${row.req.slice(0, 56)}" — ${err.message}`);
  }
}

console.log(`\n  ${pass}/${MATRIX.length} routed correctly\n`);
if (failures.length > 0) {
  console.log('  failures:');
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
