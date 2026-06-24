#!/usr/bin/env node
/**
 * CALIBRATION harness for AO8-4 NL-routed scheduling (#208). Runs the REAL prompts
 * against REAL Kimi and asserts, multi-language:
 *   (1) the intent classifier routes recurring requests to `schedule` (and does
 *       NOT route plain one-shot builds/questions there), and
 *   (2) the schedule extractor returns a {cadence, task} whose cadence
 *       `parseScheduleSpec` actually accepts (so the REPL can persist a job).
 *
 * GATED: exits 0 (SKIP) when no Moonshot key is present. Run:
 *   MOONSHOT_API_KEY="$(cat ~/.config/excalibur/moonshot.key)" node scripts/verify-schedule-routing.mjs
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildDecisionPrompt,
  parseTurnDecision,
  buildScheduleExtractionPrompt,
  parseScheduleExtraction,
  parseScheduleSpec,
  describeSpec,
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
  console.log('⚠ verify-schedule-routing SKIPPED — no Kimi/Moonshot key.');
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
      max_tokens: 1200,
    }),
  });
  if (!res.ok) throw new Error(`Kimi ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? '';
}

// Each row: a request, whether it should route to `schedule`, and (when it should)
// the cadence kind we expect the extractor to land on.
const MATRIX = [
  // --- SHOULD route to schedule + extract a usable cadence ---
  { req: 'every morning run the test sweep', schedule: true, kind: 'dailyAt' },
  { req: 'run the full lint check every 2 hours', schedule: true, kind: 'interval' },
  { req: 'cada noche publica el informe de cobertura', schedule: true, kind: 'dailyAt' },
  {
    req: 'cada 30 minutos haz un git fetch y avísame de cambios',
    schedule: true,
    kind: 'interval',
  },
  { req: 'daily at 14:30 regenerate the API docs', schedule: true, kind: 'dailyAt' },
  { req: 'chaque heure, lance la suite de tests', schedule: true, kind: 'interval' },
  // --- should NOT route to schedule (one-shot work / questions) ---
  { req: 'add a --version flag that prints the package version', schedule: false },
  { req: 'run the test suite now', schedule: false },
  { req: 'what does the scheduler module do?', schedule: false },
];

let pass = 0;
const failures = [];
console.log(`\n  schedule-routing calibration · ${MATRIX.length} requests vs ${MODEL}\n`);

for (const row of MATRIX) {
  try {
    const decision = parseTurnDecision(await ask(buildDecisionPrompt(row.req)));
    const routedSchedule = decision.intent === 'schedule';
    let ok = routedSchedule === row.schedule;
    let detail = `intent=${decision.intent}`;

    // For rows that SHOULD schedule, also exercise the extractor end-to-end.
    if (row.schedule && routedSchedule) {
      const extracted = parseScheduleExtraction(await ask(buildScheduleExtractionPrompt(row.req)));
      if (extracted === null) {
        ok = false;
        detail += ' · extract=NULL';
      } else {
        const spec = parseScheduleSpec(extracted.cadence);
        if (spec === null) {
          ok = false;
          detail += ` · cadence="${extracted.cadence}" UNPARSEABLE`;
        } else {
          if (spec.type !== row.kind) {
            ok = false;
            detail += ` · kind=${spec.type} [want ${row.kind}]`;
          }
          detail += ` · "${describeSpec(spec)}" → "${extracted.task.slice(0, 32)}"`;
        }
      }
    }

    if (ok) pass += 1;
    else failures.push(`"${row.req.slice(0, 46)}…" want schedule=${row.schedule} · ${detail}`);
    console.log(
      `  ${ok ? '✓' : '✗'} schedule=${String(routedSchedule).padEnd(5)} [want ${String(row.schedule).padEnd(5)}]  ${detail.padEnd(48)} ${row.req.slice(0, 30)}`,
    );
  } catch (err) {
    failures.push(`ERROR "${row.req.slice(0, 46)}…": ${err.message}`);
    console.log(`  ⚠ ERROR  ${row.req.slice(0, 56)}`);
  }
}

console.log(`\n  ${pass}/${MATRIX.length} matched the spec.`);
if (failures.length > 0) {
  console.log('\n  MISMATCHES:');
  for (const f of failures) console.log(`   - ${f}`);
  process.exit(1);
}
console.log('  ✓ schedule routing + extraction calibrated correctly vs real Kimi.\n');
