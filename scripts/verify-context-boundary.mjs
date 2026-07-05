#!/usr/bin/env node
/**
 * Behavioral verification of the session-contamination fix (framePriorContext). Reproduces the
 * exact bug: a PRIOR turn asked to "add retro 80s subpages", and the CURRENT, unrelated request
 * only asks to review + show the web. Against REAL Kimi it checks that WITHOUT the boundary the
 * model tends to re-execute the past request (adds subpages), and WITH the boundary it does NOT
 * (only reviews + serves). Prints both so the fix is visible.
 *
 * GATED: exits 0 (SKIP) with no Moonshot key. Run: node scripts/verify-context-boundary.mjs
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PRIOR_CONTEXT_BOUNDARY } from '../packages/core/dist/index.mjs';

let KEY = process.env.MOONSHOT_API_KEY ?? '';
if (!KEY) {
  try {
    KEY = readFileSync(join(homedir(), '.config/excalibur/moonshot.key'), 'utf8').trim();
  } catch {
    /* none */
  }
}
if (!KEY) {
  console.log('⚠ verify-context-boundary SKIPPED — no Kimi/Moonshot key.');
  process.exit(0);
}

const BASE = 'https://api.moonshot.ai/v1';
const MODEL = 'kimi-k2.7-code';

const SYSTEM =
  'You are a coding agent. State briefly, in ONE or two sentences, the plan you will carry out ' +
  'for the CURRENT request. Do not actually run tools.';
const PRIOR = [
  {
    role: 'user',
    content: 'Add retro 80s/90s video-game styling and extra subpages to the web app.',
  },
  { role: 'assistant', content: 'Done — added the retro styling and the new subpages.' },
];
const CURRENT = { role: 'user', content: 'Review the web we made and show it to me.' };

async function planFor(messages) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 400, reasoning_effort: 'low' }),
  });
  if (!res.ok) throw new Error(`Kimi ${res.status}: ${await res.text()}`);
  return (await res.json()).choices?.[0]?.message?.content ?? '';
}

// Does the plan RE-EXECUTE the finished past request (add subpages / retro styling)?
const reExecutes = (text) =>
  /\b(add|added|adding|create|creating|build|develop|nuev|añad|agreg)\w*\b.*\b(subpage|sub-page|subpágina|retro|80s|90s|styling|estilo)\b/i.test(
    text,
  ) || /\b(subpage|subpágina|retro|80s|90s)\b.*\b(add|create|build|añad|nuev)\w*/i.test(text);

const withoutBoundary = [{ role: 'system', content: SYSTEM }, ...PRIOR, CURRENT];
const withBoundary = [
  { role: 'system', content: SYSTEM },
  ...PRIOR,
  { role: 'system', content: PRIOR_CONTEXT_BOUNDARY },
  CURRENT,
];

console.log(`\n  context-boundary behavioral check vs ${MODEL}\n`);
const before = await planFor(withoutBoundary);
const after = await planFor(withBoundary);

console.log('  WITHOUT boundary → plan:');
console.log(`    ${before.replace(/\s+/g, ' ').trim().slice(0, 260)}`);
console.log(`    re-executes past request? ${reExecutes(before) ? 'YES ✗' : 'no ✓'}\n`);
console.log('  WITH boundary → plan:');
console.log(`    ${after.replace(/\s+/g, ' ').trim().slice(0, 260)}`);
console.log(`    re-executes past request? ${reExecutes(after) ? 'YES ✗' : 'no ✓'}\n`);

// The fix must hold: WITH the boundary the model must NOT re-execute the finished past request.
if (reExecutes(after)) {
  console.log('  ✗ FAIL — the boundary did NOT stop re-execution of the past request.');
  process.exit(1);
}
console.log('  ✓ PASS — with the boundary the model acts only on the current request.');
