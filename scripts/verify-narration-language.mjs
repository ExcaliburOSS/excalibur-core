#!/usr/bin/env node
/**
 * REAL-model behavioural check for the narration-language fix.
 *
 * The bug: the narration system-prompt had Spanish examples + a "Spanish →
 * Spanish" instruction baked in, which biased the model to answer in Spanish
 * even for an ENGLISH request (reproduced in the pre-launch soak: English task
 * → Spanish narration). We neutralized the bias and made the rule explicit:
 * "mirror the user's message language; do NOT default to Spanish."
 *
 * This sends the EXACT fixed narration guidance as a system prompt + a plain
 * ENGLISH user turn to a real model and asserts the reply comes back in English
 * — and, as a control, that a Spanish turn still comes back in Spanish.
 *
 * GATED: exits 0 (SKIP) without a key. PREFERS the real production model (Kimi /
 * Moonshot) so the check runs against the model that actually reproduced the bug;
 * falls back to Groq or OpenAI (both OpenAI-compatible) when no Kimi key is around.
 *   MOONSHOT_API_KEY="$(cat ~/.config/excalibur/moonshot.key)" node scripts/verify-narration-language.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY_FILE = join(homedir(), '.config/excalibur/moonshot.key');
const MOONSHOT_KEY =
  process.env.MOONSHOT_API_KEY ??
  (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, 'utf8').trim() : undefined);

// Kimi is the real production model — verify against it first. It only accepts
// temperature 1 (a lower value is a 400), so `temp` is per-provider.
const KIMI = {
  url: 'https://api.moonshot.ai/v1/chat/completions',
  key: MOONSHOT_KEY,
  model: 'kimi-k2.7-code',
  temp: 1,
};
const GROQ = {
  url: 'https://api.groq.com/openai/v1/chat/completions',
  key: process.env.GROQ_API_KEY,
  model: 'llama-3.3-70b-versatile',
  temp: 0.2,
};
const OPENAI = {
  url: 'https://api.openai.com/v1/chat/completions',
  key: process.env.OPENAI_API_KEY,
  model: 'gpt-4o-mini',
  temp: 0.2,
};
const provider = KIMI.key ? KIMI : GROQ.key ? GROQ : OPENAI.key ? OPENAI : null;
if (!provider) {
  console.log('⚠ verify-narration-language SKIPPED — no MOONSHOT/GROQ/OPENAI key.');
  process.exit(0);
}

// The EXACT narration guidance from native-agent-adapter.ts (post-fix). Kept in
// sync by hand — the unit tests assert the source strings; this proves a real
// model actually complies with them.
const NARRATION = [
  'Narrate your work like a warm, engaged pair-programmer sitting next to the user —',
  'genuine, encouraging, human — so they are NEVER left watching a silent cursor.',
  'Open EVERY turn by briefly echoing back what they asked, IN YOUR OWN WORDS, so',
  'they feel heard before anything happens (e.g. "Got it — you want X; let me start',
  'by understanding Y…"). Address the user directly and personally; a touch of warmth',
  'or light enthusiasm is welcome, never robotic.',
  "CRITICAL — LANGUAGE: Write this narration in the SAME language as the user's most",
  'recent message. If they wrote in English, respond in English; if in Spanish, respond',
  'in Spanish; match whatever language they used. Do NOT default to Spanish (or any',
  'other language) — mirror the user. Never mix languages within a response.',
].join('\n');

async function ask(userText) {
  const res = await fetch(provider.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${provider.key}`,
    },
    body: JSON.stringify({
      model: provider.model,
      temperature: provider.temp,
      messages: [
        { role: 'system', content: NARRATION },
        { role: 'user', content: userText },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return String(json.choices?.[0]?.message?.content ?? '').trim();
}

// Cheap language heuristic: count clearly-Spanish function words/markers. English
// prose scores ~0; Spanish prose scores several.
function spanishScore(text) {
  const t = ` ${text.toLowerCase()} `;
  const markers = [
    ' vamos ',
    ' voy a ',
    ' primero ',
    ' el proyecto ',
    ' la tarea ',
    ' está ',
    ' añadir ',
    ' página ',
    ' vas a ',
    ' quieres ',
    ' entiendo ',
    ' así que ',
    ' echo un vistazo ',
    ' de acuerdo ',
    ' perfecto, ',
    ' vale ',
    ' tú ',
    'ñ',
    '¡',
    '¿',
  ];
  return markers.reduce((n, m) => n + (t.includes(m) ? 1 : 0), 0);
}
function englishScore(text) {
  const t = ` ${text.toLowerCase()} `;
  const markers = [
    " i'll ",
    ' let me ',
    ' you want ',
    ' got it ',
    ' first ',
    ' the project ',
    ' i will ',
    ' understand ',
    ' start by ',
    ' looking ',
    ' add ',
    ' page ',
  ];
  return markers.reduce((n, m) => n + (t.includes(m) ? 1 : 0), 0);
}

const EN_TASK =
  'add an About subpage at public/about.html matching the site style, and link it from the nav';
const ES_TASK =
  'añade una subpágina "Acerca de" en public/about.html con el mismo estilo del sitio y enlázala desde el menú';

console.log(`\n  narration-language check · ${provider.model}\n`);

const enReply = await ask(EN_TASK);
const esReply = await ask(ES_TASK);

console.log(`  EN task → reply: "${enReply.slice(0, 120).replace(/\n/g, ' ')}…"`);
console.log(`  ES task → reply: "${esReply.slice(0, 120).replace(/\n/g, ' ')}…"\n`);

const enSp = spanishScore(enReply);
const enEn = englishScore(enReply);
const esSp = spanishScore(esReply);

let ok = true;
if (enSp > enEn || enEn === 0) {
  console.error(
    `  ✗ FAIL: English request produced non-English narration (es=${enSp}, en=${enEn}).`,
  );
  ok = false;
} else {
  console.log(`  ✓ English request → English narration (en=${enEn}, es=${enSp}).`);
}
if (esSp === 0) {
  console.error(`  ✗ FAIL: Spanish request did not produce Spanish narration (es=${esSp}).`);
  ok = false;
} else {
  console.log(`  ✓ Spanish request → Spanish narration (es=${esSp}).`);
}

console.log('');
process.exit(ok ? 0 : 1);
