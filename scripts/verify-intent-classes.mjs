#!/usr/bin/env node
/**
 * Intent-simplification verification (docs/strategy/intent-simplification.md): runs the REAL
 * decision prompt against REAL Kimi and asserts every request collapses onto the correct
 * CANONICAL class (chat · build · preview · discovery · history · orchestration) via
 * `intentClass`. This is the routing gate for the 6-class taxonomy — a green run means the
 * classifier + mapping route the 14 fine intents onto the 6 the user actually cares about.
 *
 * GATED: exits 0 (SKIP) when no Moonshot key is present. Run:
 *   node scripts/verify-intent-classes.mjs
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildDecisionPrompt,
  parseTurnDecision,
  intentClass,
} from '../packages/core/dist/index.mjs';

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
  console.log('⚠ verify-intent-classes SKIPPED — no Kimi/Moonshot key.');
  process.exit(0);
}

const BASE = 'https://api.moonshot.ai/v1';
const MODEL = 'kimi-k2.7-code';
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

// Each row: a request (multi-language) and the CANONICAL class it must collapse onto.
const MATRIX = [
  // chat (informative; research folds in — chat reaches for the web itself)
  { req: 'how does authentication work in this repo?', cls: 'chat' },
  { req: '¿qué implica añadir soporte de pagos con Stripe?', cls: 'chat' },
  { req: 'compara online las opciones actuales de bases de datos vectoriales', cls: 'chat' },
  // build (edit/plan/swarm/mission/goal/explore/bg/schedule all collapse here)
  { req: 'add a --version flag that prints the package version', cls: 'build' },
  { req: 'rename the variable usr to user in auth.ts', cls: 'build' },
  {
    req: 'desarrolla subpáginas para la web, revísalas y añade estilo retro de los 80',
    cls: 'build',
  },
  { req: 'refactor the payment module across services, add tests and open a PR', cls: 'build' },
  { req: 'migrate the whole API from REST to GraphQL end to end', cls: 'build' },
  { req: 'prueba un par de enfoques para el caché y quédate con el mejor', cls: 'build' },
  { req: 'sigue iterando hasta que pasen todos los tests', cls: 'build' },
  { req: 'run the full test sweep in the background while I keep working', cls: 'build' },
  { req: 'cada mañana ejecuta la batería de tests y arregla lo que falle', cls: 'build' },
  // preview (see/run the existing app)
  { req: 'enséñame la web en local', cls: 'preview' },
  { req: 'revisa la web y enséñamela', cls: 'preview' },
  // discovery (floats an idea, wants a verdict)
  { req: '¿y si la app pudiese generar informes en PDF? ¿merece la pena?', cls: 'discovery' },
  // history (undo/rewind own work)
  { req: 'deshaz el último cambio que hiciste', cls: 'history' },
  // orchestration (view/manage an existing run)
  { req: 'muéstrame el cronograma del swarm que está corriendo', cls: 'orchestration' },
];

let pass = 0;
const failures = [];
console.log(`\n  intent-class calibration · ${MATRIX.length} requests vs ${MODEL}\n`);

for (const row of MATRIX) {
  try {
    const decision = parseTurnDecision(await ask(buildDecisionPrompt(row.req)));
    const cls = intentClass(decision.intent);
    const ok = cls === row.cls;
    console.log(
      `  ${ok ? '✓' : '✗'} [want ${row.cls.padEnd(13)}] class=${cls.padEnd(13)} intent=${decision.intent.padEnd(12)} "${row.req.slice(0, 52)}"`,
    );
    if (ok) pass += 1;
    else failures.push(`${row.req} → ${cls} (intent ${decision.intent}; wanted ${row.cls})`);
  } catch (err) {
    failures.push(`${row.req} → ERROR ${err.message}`);
    console.log(`  ✗ ERROR  "${row.req.slice(0, 52)}" — ${err.message}`);
  }
}

console.log(`\n  ${pass}/${MATRIX.length} collapsed to the right class\n`);
if (failures.length > 0) {
  console.log('  failures:');
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
