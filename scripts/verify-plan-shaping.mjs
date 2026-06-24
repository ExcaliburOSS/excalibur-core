#!/usr/bin/env node
/**
 * CALIBRATION harness for plan-shaping (#198). Runs the REAL prompt against REAL
 * Kimi across a matrix of request shapes and asserts the GATE behaves per spec:
 * shaping must stay SILENT for small / clear-medium tasks and fire ONLY for a
 * large plan, an unclear design, or genuine optional scope.
 *
 * GATED: exits 0 (SKIP) when no Moonshot key is present. Run:
 *   MOONSHOT_API_KEY="$(cat ~/.config/excalibur/moonshot.key)" node scripts/verify-plan-shaping.mjs
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildPlanShapePrompt,
  parsePlanShape,
  shouldSurfacePlanShape,
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
  console.log('⚠ verify-plan-shaping SKIPPED — no Kimi/Moonshot key.');
  process.exit(0);
}

const BASE = 'https://api.moonshot.ai/v1';
const MODEL = 'kimi-k2.7-code';

/** One Kimi chat call (temperature OMITTED — Kimi allows only the default). */
async function ask(prompt) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      // Match the production adapter — a smaller budget truncates verbose-language
      // (e.g. Spanish) replies mid-JSON, which would parse as empty (false skip).
      max_tokens: 1200,
    }),
  });
  if (!res.ok) throw new Error(`Kimi ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}

// Matrix: each row is a realistic request + whether the gate SHOULD surface.
// `lang` just documents that we cover non-English (router is language-agnostic).
const MATRIX = [
  // --- should STAY SILENT (the core fear: no nagging on small/clear work) ---
  {
    req: 'Increase the HTTP client timeout from 5s to 30s in src/http.ts',
    surface: false,
    why: 'small localized change',
  },
  { req: 'Fix the typo "recieve" → "receive" in the README', surface: false, why: 'trivial fix' },
  {
    req: 'Add a `--version` flag that prints the package.json version and exits',
    surface: false,
    why: 'clear, self-contained',
  },
  {
    req: 'Cambia el color del botón de login de azul a verde en el componente LoginButton',
    surface: false,
    why: 'clear small (es)',
  },
  {
    req: 'Add a unit test for the existing `slugify()` function covering empty + unicode input',
    surface: false,
    why: 'clear medium, self-contained',
  },
  // --- should SURFACE: large / unclear / genuine optional scope ---
  {
    req: 'Build a real-time collaborative document editor with offline sync and conflict resolution',
    surface: true,
    why: 'large + design-defining decisions',
  },
  {
    req: 'Migrate the whole app from REST to GraphQL across the API and all clients',
    surface: true,
    why: 'large migration',
  },
  {
    req: 'Add authentication to the API',
    surface: true,
    why: 'unclear: auth strategy unspecified',
  },
  {
    req: 'Construye un sistema de notificaciones (in-app, email y push) para la plataforma',
    surface: true,
    why: 'large + optional channels/scope (es)',
  },
  {
    req: 'Add full-text search across the product catalog with filters and ranking',
    surface: true,
    why: 'large + design decisions (engine, indexing, ranking)',
  },
];

let pass = 0;
const failures = [];
console.log(`\n  plan-shaping calibration · ${MATRIX.length} requests vs ${MODEL}\n`);
for (const row of MATRIX) {
  let shape;
  try {
    shape = parsePlanShape(await ask(buildPlanShapePrompt(row.req)));
  } catch (err) {
    failures.push(`ERROR "${row.req.slice(0, 50)}…": ${err.message}`);
    console.log(`  ⚠ ERROR  ${row.req.slice(0, 56)}`);
    continue;
  }
  const surfaced = shouldSurfacePlanShape(shape);
  const ok = surfaced === row.surface;
  if (ok) pass += 1;
  else
    failures.push(
      `"${row.req.slice(0, 50)}…" expected surface=${row.surface} got ${surfaced} ` +
        `(complexity=${shape.complexity} clear=${shape.clear} q=${shape.questions.length} r=${shape.recommendations.length})`,
    );
  const mark = ok ? '✓' : '✗';
  console.log(
    `  ${mark} surface=${String(surfaced).padEnd(5)} [want ${String(row.surface).padEnd(5)}] ` +
      `cx=${shape.complexity.padEnd(6)} clear=${String(shape.clear).padEnd(5)} ` +
      `q=${shape.questions.length} r=${shape.recommendations.length}  ${row.req.slice(0, 44)}`,
  );
}

console.log(`\n  ${pass}/${MATRIX.length} matched the spec.`);
if (failures.length > 0) {
  console.log('\n  MISMATCHES:');
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log('  ✓ plan-shaping gate calibrated correctly vs real Kimi.\n');
