/**
 * Conversational intent router (heuristic, zero-cost, deterministic).
 *
 * Excalibur must be proactive: a natural-language line should reach the RIGHT
 * machinery without the user typing an arcane slash command. This pure classifier
 * detects, from the message alone, whether a turn wants:
 *  - 'plan'  — a multi-step build/change → plan-mode (read-only plan → gate → run)
 *  - 'swarm' — parallelizable / many independent parts → fan out to real agents
 *  - 'bg'    — a long-running task to run in the background while you keep working
 *  - 'chat'  — anything else (a question or one direct action) → a direct turn
 *
 * Routing only ENGAGES with a real model AND an interactive terminal at an
 * act-capable autonomy level (≥ 2) — otherwise it returns 'chat', so piped / CI /
 * mock / read-only paths keep doing a plain direct turn exactly as before (a plan
 * can't be approved without a human, so it must never be forced there). `swarm`
 * and `bg` are OFFERED by the REPL (never silently rerouted); `plan` carries its
 * own approve/edit/cancel gate. Mirrors the existing goal-intent offer.
 */
export type TurnIntent = 'chat' | 'plan' | 'swarm' | 'bg';

export interface IntentContext {
  /** A real human at a TTY who can answer prompts (plan/offers need this). */
  interactive: boolean;
  /** The provider is the deterministic mock (no real model → never route). */
  mock: boolean;
  /** Session autonomy level — routing needs an act-capable level (≥ 2). */
  level: number;
}

// A question is answered directly even when it mentions build/parallel words.
const QUESTION =
  /(^|\s)(how|why|what|whats|where|when|which|who|whose|does|do|did|is|are|can|could|should|would|explain|cómo|como|qué|que|por qué|por que|cuál|cual|dónde|donde|cuándo|cuando|quién|quien|explica|puedes)\b|\?\s*$/i;
const BG =
  /\b(in the background|background|while i|in the meantime|meanwhile|en segundo plano|de fondo|mientras (tanto|sigo|yo|trabajo|sigo trabajando))\b/i;
const SWARM =
  /\b(in parallel|fan[\s-]?out|each of (these|the|them)|all of (these|them)|across (all|every)|one (for|per) each|several (files|modules|services|packages|endpoints)|en paralelo|cada uno de|(en|para) todos los|(en|para) todas las|en cada uno)\b/i;
const PLAN =
  /\b(implement|refactor|redesign|re[\s-]?write|migrate|build (a|an|the)|add (a|an|the|support)|introduce|set up|wire up|integrate|create (a|an|the)|scaffold|implementa|refactoriza|rediseña|reescribe|migra|añade|agrega|crea (un|una|el|la|soporte)|monta|integra|construye)\b/i;

/** Classifies a natural-language turn. Pure + deterministic (no model call). */
export function classifyTurnIntent(text: string, ctx: IntentContext): TurnIntent {
  if (ctx.mock || !ctx.interactive || ctx.level < 2) {
    return 'chat';
  }
  const t = text.trim();
  if (t.length === 0 || QUESTION.test(t)) {
    return 'chat';
  }
  if (BG.test(t)) {
    return 'bg';
  }
  if (SWARM.test(t)) {
    return 'swarm';
  }
  if (PLAN.test(t)) {
    return 'plan';
  }
  return 'chat';
}
