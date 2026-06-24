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

// TOKEN BUDGETS — the AO8-4 review (wb286j6ma) caught that an earlier 1200-token
// harness FALSE-greened while the REPL fed the extraction through the 6-token intent
// classifier and truncated it to null. The fix raised the production extraction
// adapter to a generous ceiling; this harness now mirrors THAT:
//   - EXTRACT_MAXTOKENS mirrors SCHEDULE_EXTRACT_MAXTOKENS in apps/cli/src/session/
//     repl.ts (buildCheapModel ceiling for kind:'schedule-extract'). Keep in sync.
//   - The model under test, kimi-k2.7-code, is a REASONING model: at a 6-token
//     budget it spends the whole budget thinking and emits empty content, so it
//     CANNOT emulate production's fast 6-token intent model. We therefore drive the
//     routing decision with a bounded `reasoning_effort:'low'` + a small budget that
//     lets it emit the one-word answer. This verifies the PROMPT + PARSER against the
//     real verify model; production routing uses a separate fast model at 6 tokens.
const EXTRACT_MAXTOKENS = 1200; // == SCHEDULE_EXTRACT_MAXTOKENS in repl.ts
const DECISION_MAXTOKENS = 256; // enough for kimi (low effort) to reason + emit 2 words

/** One Kimi chat call at a SPECIFIC token budget (temperature OMITTED — Kimi allows
 * only the default). `extra` carries per-call knobs (e.g. reasoning_effort). */
async function ask(prompt, maxTokens, extra = {}) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      ...extra,
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
    const decision = parseTurnDecision(
      await ask(buildDecisionPrompt(row.req), DECISION_MAXTOKENS, { reasoning_effort: 'low' }),
    );
    const routedSchedule = decision.intent === 'schedule';
    let ok = routedSchedule === row.schedule;
    let detail = `intent=${decision.intent}`;

    // For rows that SHOULD schedule, also exercise the extractor end-to-end — at the
    // SAME ceiling the REPL's extraction adapter uses (EXTRACT_MAXTOKENS), so a
    // too-small cap (the bug the review caught) would fail loudly here.
    if (row.schedule && routedSchedule) {
      const extracted = parseScheduleExtraction(
        await ask(buildScheduleExtractionPrompt(row.req), EXTRACT_MAXTOKENS),
      );
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
