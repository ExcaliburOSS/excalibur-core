import { type AutonomyLevel, type ExcaliburConfig } from '@excalibur/shared';
import { DEFAULT_SAFETY_PRESET_ID, SAFETY_PRESETS } from '../onboarding/onboarding';

/**
 * Structural input parsing + the StatusLine model for the M-Shell REPL.
 *
 * The shell is MODEL-FIRST. {@link parseStructuralInput} recognises only the two
 * STRUCTURAL forms (syntax, not language): a leading `/` slash command and a
 * leading `!` shell passthrough. Everything else is a natural-language turn.
 *
 * Conversational INTENT (plan / swarm / bg / research / goal vs a plain turn) is
 * detected by {@link classifyTurnIntent} using an LLM — NEVER keyword/regex — so
 * it works in ANY language; on no-model/error it falls back to a plain turn.
 */

/** A discriminated decision describing the STRUCTURAL shape of one input line. */
export type StructuralInput =
  | { kind: 'command'; name: string; argv: string[] }
  | { kind: 'shell'; command: string }
  | { kind: 'natural'; text: string };

/** Tokenises an input line into argv, respecting simple quotes. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

/**
 * Recognises the STRUCTURAL shape of one REPL line — model-free and
 * deterministic:
 *
 * - leading `/` → a slash command (`/help`, `/plan`, `/exit`, …);
 * - leading `!` → a shell passthrough;
 * - otherwise a natural-language turn handed verbatim to the agent loop (the
 *   MODEL decides what to do — no keyword classification happens here).
 */
export function parseStructuralInput(text: string): StructuralInput {
  const trimmed = text.trim();

  if (trimmed.startsWith('/')) {
    const [name, ...argv] = tokenize(trimmed.slice(1));
    return { kind: 'command', name: (name ?? '').toLowerCase(), argv };
  }

  if (trimmed.startsWith('!')) {
    return { kind: 'shell', command: trimmed.slice(1).trim() };
  }

  return { kind: 'natural', text: trimmed };
}

/**
 * Conversational intent — what a natural-language turn wants. Detected by an LLM
 * (multi-language), NEVER by keyword/regex: a French/German/… user gets the same
 * proactive routing as an English one.
 *
 * - `chat`: a question / explanation / single direct change → a normal turn.
 * - `plan`: a multi-step build worth planning first (plan → approve → execute).
 * - `swarm`: many independent parallelizable subtasks → fan out to agents.
 * - `bg`: a long-running task to run in the background.
 * - `research`: needs external/current web info, or deep multi-source research.
 * - `goal`: an explicit "iterate until it works/passes/done" objective.
 * - `explore`: wants SEVERAL alternative approaches compared (best-of-N).
 */
export type TurnIntent = 'chat' | 'plan' | 'swarm' | 'bg' | 'research' | 'goal' | 'explore';

const TURN_INTENTS: readonly TurnIntent[] = [
  'chat',
  'plan',
  'swarm',
  'bg',
  'research',
  'goal',
  'explore',
];

export interface IntentContext {
  /** A real human at a TTY who can answer prompts (plan/offers need this). */
  interactive: boolean;
  /** The provider is the deterministic mock (no real model → never classify). */
  mock: boolean;
  /** Session autonomy level — routing needs an act-capable level (≥ 2). */
  level: number;
}

/**
 * Injected classifier call: takes the prompt, returns the model's raw answer.
 * The REPL backs this with the FAST/cheap model (low latency); core stays free
 * of any model SDK so the routing logic is unit-testable with a fake.
 */
export type IntentModel = (prompt: string, signal?: AbortSignal) => Promise<string>;

/** Builds the language-agnostic classification prompt (the MODEL handles any language). */
export function buildIntentPrompt(text: string): string {
  return [
    'You are an intent classifier for a coding-agent CLI. Read the user request in ANY language',
    'and choose the SINGLE best category:',
    '- chat: a question, explanation, or one small direct change the agent can just do.',
    '- plan: a multi-step build/change worth planning first.',
    '- swarm: many independent, parallelizable subtasks.',
    '- bg: a long-running task to run in the background.',
    '- research: needs external/current information from the web, or deep investigation.',
    '- goal: an explicit "keep iterating until it works/passes/done" objective.',
    '- explore: explicitly wants SEVERAL alternative approaches compared, best-of-N, "try a few ways and pick the best".',
    'Answer with ONLY the category word (chat, plan, swarm, bg, research, goal, or explore).',
    '',
    `Request: ${text}`,
  ].join('\n');
}

/** Maps a model answer to a {@link TurnIntent}; anything unrecognized → `chat`. */
export function parseTurnIntent(modelOutput: string): TurnIntent {
  const tokens = modelOutput.toLowerCase().match(/[a-z]+/g) ?? [];
  const found = tokens.find((t) => (TURN_INTENTS as readonly string[]).includes(t));
  return (found as TurnIntent | undefined) ?? 'chat';
}

/**
 * The classifier's confidence in its category — AO3d-2. Drives the proactive
 * posture: a LOW-confidence read never silently runs a heavy route, it asks.
 */
export type TurnConfidence = 'high' | 'medium' | 'low';
const TURN_CONFIDENCES: readonly TurnConfidence[] = ['high', 'medium', 'low'];

/** A classified turn: the chosen shape + how confident the classifier is. */
export interface TurnDecision {
  intent: TurnIntent;
  confidence: TurnConfidence;
}

/** Builds the classifier prompt that asks for the category AND a confidence word. */
export function buildDecisionPrompt(text: string): string {
  return [
    'You are an intent classifier for a coding-agent CLI. Read the user request in ANY language',
    'and choose the SINGLE best category AND your confidence in that choice:',
    '- chat: a question, explanation, or one small direct change the agent can just do.',
    '- plan: a multi-step build/change worth planning first.',
    '- swarm: many independent, parallelizable subtasks.',
    '- bg: a long-running task to run in the background.',
    '- research: needs external/current information from the web, or deep investigation.',
    '- goal: an explicit "keep iterating until it works/passes/done" objective.',
    '- explore: explicitly wants SEVERAL alternative approaches compared, best-of-N, "try a few ways and pick the best".',
    'Answer with EXACTLY two words: the category then the confidence (high, medium, or low).',
    'Example: "swarm high" or "chat low".',
    '',
    `Request: ${text}`,
  ].join('\n');
}

/** Extracts the confidence word from a model answer; unrecognized → `medium`. */
export function parseTurnConfidence(modelOutput: string): TurnConfidence {
  const tokens = modelOutput.toLowerCase().match(/[a-z]+/g) ?? [];
  const found = tokens.find((t) => (TURN_CONFIDENCES as readonly string[]).includes(t));
  return (found as TurnConfidence | undefined) ?? 'medium';
}

/** Parses a model answer into a full {@link TurnDecision} (intent + confidence). */
export function parseTurnDecision(modelOutput: string): TurnDecision {
  return { intent: parseTurnIntent(modelOutput), confidence: parseTurnConfidence(modelOutput) };
}

/**
 * Classifies a turn into a {@link TurnDecision} (intent + confidence) via the
 * injected LLM. Same gating as {@link classifyTurnIntent}: gated to a confident
 * `chat` when there is no real model, off a TTY, at a read-only level, on empty
 * text, or on any classifier error.
 */
export async function classifyTurnDecision(
  text: string,
  ctx: IntentContext,
  classify: IntentModel,
  signal?: AbortSignal,
): Promise<TurnDecision> {
  if (ctx.mock || !ctx.interactive || ctx.level < 2 || text.trim().length === 0) {
    return { intent: 'chat', confidence: 'high' };
  }
  try {
    return parseTurnDecision(await classify(buildDecisionPrompt(text), signal));
  } catch {
    return { intent: 'chat', confidence: 'high' };
  }
}

/** Reversibility/impact of an execution shape (AO3d-2) — pure. Research/chat are
 * read-ish (low); a build/swarm/bg mutates but is git-isolated + revertible
 * (medium); an open-ended goal loop iterates autonomously (high). */
export type ShapeRisk = 'low' | 'medium' | 'high';
export function riskOfShape(intent: TurnIntent): ShapeRisk {
  switch (intent) {
    case 'chat':
    case 'research':
      return 'low';
    case 'plan':
    case 'swarm':
    case 'bg':
      return 'medium';
    case 'goal':
    case 'explore':
      // explore fans out N candidate agents — a cost amplifier, so it ASKS unless
      // full autonomy is granted (matches the roadmap's caution on auto-routing it).
      return 'high';
  }
}

/** What the shell should DO with a routed turn (AO3d-2) — pure, no I/O. */
export type RoutePosture = 'act' | 'narrate' | 'ask';

/**
 * The proactive 3-way posture (AO3d-2), derived from confidence + shape risk +
 * autonomy — NOT a binary flag. Excalibur acts on safe/likely routes, narrates
 * while acting on high-impact ones under full autonomy, and asks when it is
 * unsure or the route is high-impact and autonomy isn't granted. A low-confidence
 * read NEVER silently runs a heavy route.
 */
export function decidePosture(input: {
  risk: ShapeRisk;
  confidence: TurnConfidence;
  level: number;
  autoApprove: boolean;
}): RoutePosture {
  if (input.confidence === 'low') return 'ask';
  if (input.risk === 'high') return input.autoApprove ? 'narrate' : 'ask';
  if (input.risk === 'medium') return input.autoApprove || input.level >= 3 ? 'act' : 'ask';
  return input.autoApprove || input.level >= 2 ? 'act' : 'ask';
}

/**
 * Classifies a natural-language turn via the injected LLM (multi-language). Gated
 * to `chat` (a plain model-first turn — the safe default) when there is no real
 * model, off a TTY, at a read-only level, or on any classifier error/timeout, so
 * the shell never blocks on classification.
 */
export async function classifyTurnIntent(
  text: string,
  ctx: IntentContext,
  classify: IntentModel,
  signal?: AbortSignal,
): Promise<TurnIntent> {
  if (ctx.mock || !ctx.interactive || ctx.level < 2 || text.trim().length === 0) {
    return 'chat';
  }
  try {
    return parseTurnIntent(await classify(buildIntentPrompt(text), signal));
  } catch {
    return 'chat';
  }
}

/** The surface-agnostic model backing the StatusLine. */
export interface StatusLineModel {
  /** Autonomy label for the active lane / default. */
  autonomy: string;
  /** Active workflow id (or a lane label before a turn runs). */
  workflow: string;
  /** Provider/model name (e.g. `mock`). */
  model: string;
  /** Running cost sum, in cents. */
  costCents: number;
  /** Safety preset id. */
  safety: string;
}

export interface BuildStatusLineInput {
  config: ExcaliburConfig;
  /** Provider/model name from the gateway context. */
  model: string;
  /** Running cost sum so far, in cents. */
  costCents?: number;
  /** Autonomy level for the active lane (defaults to the config default). */
  autonomyLevel?: AutonomyLevel;
  /** Active workflow id / lane label. */
  workflow?: string;
}

/**
 * Builds the surface-agnostic {@link StatusLineModel} the CLI (and the future
 * Ink surface) render after each turn. Pure: no Ui, no IO.
 */
export function buildStatusLineModel(input: BuildStatusLineInput): StatusLineModel {
  const presetId = input.config.safety?.preset ?? DEFAULT_SAFETY_PRESET_ID;
  const safety = SAFETY_PRESETS[presetId] !== undefined ? presetId : DEFAULT_SAFETY_PRESET_ID;
  const autonomyLevel = input.autonomyLevel ?? input.config.autonomy?.default ?? 3;
  return {
    autonomy: AUTONOMY_LABELS[autonomyLevel] ?? `L${autonomyLevel}`,
    workflow: input.workflow ?? 'conversation',
    model: input.model,
    costCents: input.costCents ?? 0,
    safety,
  };
}

/** Compact autonomy labels for the StatusLine. */
const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  0: 'L0 Review',
  1: 'L1 Assist',
  2: 'L2 Patch',
  3: 'L3 Branch',
  4: 'L4 Agentic',
};
