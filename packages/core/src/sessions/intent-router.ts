import { type AutonomyLevel, type ExcaliburConfig } from '@excalibur/shared';
import { DEFAULT_SAFETY_PRESET_ID, SAFETY_PRESETS } from '../onboarding/onboarding';
import { firstJsonObject } from './plan-shaping';

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

  // Universal terminal convention: a bare `exit` / `quit` as the WHOLE line leaves
  // the shell, even without a leading slash — every REPL (node, python, psql, …)
  // honours it, and someone typing only "exit" means "get me out", never a task.
  const bare = trimmed.toLowerCase();
  if (bare === 'exit' || bare === 'quit') {
    return { kind: 'command', name: bare, argv: [] };
  }

  return { kind: 'natural', text: trimmed };
}

/**
 * Conversational intent — what a natural-language turn wants. Detected by an LLM
 * (multi-language), NEVER by keyword/regex: a French/German/… user gets the same
 * proactive routing as an English one.
 *
 * - `chat`: a question / explanation — NO files are created or changed.
 * - `edit`: one small, direct code/file change → the gated workflow engine
 *   (fast-fix), so even a quick change in the m-shell gets the same quality
 *   (tests/typecheck/verify) as `excalibur run`, never a bare loop (RUN-FIX-10).
 * - `plan`: a multi-step build worth planning first (plan → approve → execute).
 * - `swarm`: many independent parallelizable subtasks → fan out to agents.
 * - `bg`: a long-running task to run in the background.
 * - `research`: needs external/current web info, or deep multi-source research.
 * - `goal`: an explicit "iterate until it works/passes/done" objective.
 * - `explore`: wants SEVERAL alternative approaches compared (best-of-N).
 * - `scope`: wants to UNDERSTAND/EVALUATE a task read-only before building (AO9-3).
 * - `schedule`: wants a task to run on a RECURRING cadence (every N / daily at).
 * - `mission`: a BIG, multi-faceted goal that needs SEVERAL capabilities composed
 *   and driven autonomously to completion (understand → plan → build/parallelize →
 *   verify → ship) — the meta-orchestrator. The proactive route for large work.
 */
export type TurnIntent =
  | 'chat'
  | 'edit'
  | 'plan'
  | 'swarm'
  | 'bg'
  | 'research'
  | 'goal'
  | 'explore'
  | 'scope'
  | 'orchestration'
  | 'schedule'
  | 'mission';

const TURN_INTENTS: readonly TurnIntent[] = [
  'chat',
  'edit',
  'plan',
  'swarm',
  'bg',
  'research',
  'goal',
  'explore',
  'scope',
  'orchestration',
  'schedule',
  'mission',
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
    '- chat: a question or explanation — answering it does NOT create or change any file.',
    '- edit: ONE small, direct code/file change (create or modify a file, fix a bug, add a function) — no planning needed, but real code is written.',
    '- plan: a multi-step build/change worth planning first.',
    '- swarm: many independent, parallelizable subtasks.',
    '- bg: a long-running task to run in the background.',
    '- research: needs external/current information from the web, or deep investigation.',
    '- goal: an explicit "keep iterating until it works/passes/done" objective.',
    '- explore: explicitly wants SEVERAL alternative approaches compared, best-of-N, "try a few ways and pick the best".',
    '- scope: wants to UNDERSTAND or EVALUATE a task read-only BEFORE building — "what is involved in X", "what would it take to", "scope/assess this", "which files/parts does X touch", "what exists vs what is missing for X", "analiza qué haría falta para", "qué implica". NO code is written.',
    '- orchestration: VIEW, PAUSE or RESUME an EXISTING parallel run — its swarm/orchestration/chronogram/timeline (not new work).',
    '- schedule: run a task on a RECURRING cadence ("every morning", "cada 2 horas", "nightly", "daily at 9", "each hour run X").',
    '- mission: a BIG, multi-faceted goal needing SEVERAL kinds of work composed and driven to completion autonomously — e.g. "build feature X end to end (design, implement across modules, test, verify, open a PR)", a large migration, "ship the whole thing". Choose this over plan/swarm/goal when the work needs MULTIPLE different phases, not just one.',
    'Answer with ONLY the category word (chat, edit, plan, swarm, bg, research, goal, explore, scope, orchestration, schedule, or mission).',
    '',
    `Request: ${text}`,
  ].join('\n');
}

/**
 * Maps a model answer to a {@link TurnIntent}; anything unrecognized → `chat`.
 * Prefers the LAST recognized token, not the first: the label sits at/near the end
 * of both the single-word ("edit") and two-word ("edit high") answer formats — and
 * of a reasoning model's trailing label — so a category word that appears earlier
 * inside the model's prose (e.g. "edit" or "plan" in a sentence) does not win over
 * the actual answer. Confidence words (high/medium/low) are not intents, so they
 * are skipped naturally.
 */
export function parseTurnIntent(modelOutput: string): TurnIntent {
  const tokens = modelOutput.toLowerCase().match(/[a-z]+/g) ?? [];
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if ((TURN_INTENTS as readonly string[]).includes(tokens[i] as string)) {
      return tokens[i] as TurnIntent;
    }
  }
  return 'chat';
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
    '- chat: a question or explanation — answering it does NOT create or change any file.',
    '- edit: ONE small, direct code/file change (create or modify a file, fix a bug, add a function) — no planning needed, but real code is written.',
    '- plan: a multi-step build/change worth planning first.',
    '- swarm: many independent, parallelizable subtasks.',
    '- bg: a long-running task to run in the background.',
    '- research: needs external/current information from the web, or deep investigation.',
    '- goal: an explicit "keep iterating until it works/passes/done" objective.',
    '- explore: explicitly wants SEVERAL alternative approaches compared, best-of-N, "try a few ways and pick the best".',
    '- scope: wants to UNDERSTAND or EVALUATE a task read-only BEFORE building — "what is involved in X", "what would it take to", "scope/assess this", "which files/parts does X touch", "qué implica", "analiza qué haría falta para". NO code is written.',
    '- orchestration: VIEW, PAUSE or RESUME an EXISTING parallel run — its swarm/orchestration/chronogram/timeline (not new work).',
    '- schedule: run a task on a RECURRING cadence ("every morning", "cada 2 horas", "nightly", "daily at 9", "each hour run X").',
    '- mission: a BIG, multi-faceted goal needing SEVERAL kinds of work composed and driven to completion autonomously (design + implement across modules + test + verify + ship, a large migration). Choose over plan/swarm/goal when the work needs MULTIPLE different phases.',
    'Answer with EXACTLY two words: the category then the confidence (high, medium, or low).',
    'Example: "swarm high" or "mission high" or "chat low".',
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
    // low: read-ish + reversible — chat/research, the read-only `scope` understand
    // pass (no writes), and `orchestration` (view/pause/resume an existing run).
    case 'chat':
    case 'research':
    case 'scope':
    case 'orchestration':
      return 'low';
    case 'edit':
    case 'plan':
    case 'swarm':
    case 'bg':
    case 'schedule':
      // edit = one small direct code change (a real mutation, but reversible);
      // schedule = add a recurring job: a reversible config write (you can remove
      // it), but it commits to FUTURE autonomous runs → confirm unless autonomy is
      // granted, like a build.
      return 'medium';
    case 'goal':
    case 'explore':
      // explore fans out N candidate agents — a cost amplifier, so it ASKS unless
      // full autonomy is granted (matches the roadmap's caution on auto-routing it).
      return 'high';
    case 'mission':
      // The meta-orchestrator: an autonomous, multi-capability, potentially long +
      // costly run. Highest impact → narrate-and-act under full autonomy, ask
      // otherwise (decidePosture maps high-risk this way).
      return 'high';
    default: {
      // Exhaustiveness guard: a future TurnIntent must be classified here, not
      // silently fall through to an undefined risk.
      const _exhaustive: never = intent;
      return _exhaustive;
    }
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

/**
 * AO6 Pillar 5 — the orchestration CONTROL action (NL, multilingual). When a turn
 * routed to `orchestration`, this micro-classifies WHICH control the user wants:
 * `show` the chronogram, `pause`, or `resume`. LLM-based (never keyword/regex) so
 * it works in any language; the default is the safe read (`show`).
 */
export type OrchestrationAction = 'show' | 'pause' | 'resume';
const ORCHESTRATION_ACTIONS: readonly OrchestrationAction[] = ['show', 'pause', 'resume'];

/** The prompt that picks the orchestration control verb (any language). */
export function buildOrchestrationActionPrompt(text: string): string {
  return [
    'The user is talking about an EXISTING parallel run (a swarm / orchestration /',
    'chronogram / timeline). In ANY language, decide which action they want:',
    '- show: view / inspect / open the chronogram or timeline (the default).',
    '- pause: pause / hold / stop dispatching it for now.',
    '- resume: resume / continue / unpause it.',
    'Answer with ONLY the word: show, pause, or resume.',
    '',
    `Request: ${text}`,
  ].join('\n');
}

/** Maps a model answer to an {@link OrchestrationAction}; unrecognized → `show`. */
export function parseOrchestrationAction(modelOutput: string): OrchestrationAction {
  const tokens = modelOutput.toLowerCase().match(/[a-z]+/g) ?? [];
  const found = tokens.find((t) => (ORCHESTRATION_ACTIONS as readonly string[]).includes(t));
  return (found as OrchestrationAction | undefined) ?? 'show';
}

/** Classifies the orchestration control verb via the injected model; `show` on any fault. */
export async function classifyOrchestrationAction(
  text: string,
  classify: IntentModel,
  signal?: AbortSignal,
): Promise<OrchestrationAction> {
  try {
    return parseOrchestrationAction(await classify(buildOrchestrationActionPrompt(text), signal));
  } catch {
    return 'show';
  }
}

/**
 * AO8-4 — NL → schedule extraction. When a turn routes to `schedule`, this pulls
 * a normalised cadence + the task out of a free-form request in ANY language
 * ("every morning run the test sweep", "cada 2 horas haz X", "nightly publish the
 * report"). The model normalises fuzzy cadences ("every morning" → "at 09:00",
 * "nightly" → "at 22:00", "hourly" → "every 1h") into a string that
 * {@link parseScheduleSpec} understands, and strips the scheduling words from the
 * task. Returns null when no usable cadence + task can be extracted (the caller
 * then falls back to asking, never silently scheduling the wrong thing).
 */
export interface ScheduleExtraction {
  /** A cadence string for `parseScheduleSpec`: "every 30m" / "2h" / "at 09:00". */
  cadence: string;
  /** The task prompt to run when the job fires (scheduling words removed). */
  task: string;
}

/** Builds the schedule-extraction prompt (any language → normalised cadence + task). */
export function buildScheduleExtractionPrompt(text: string): string {
  return [
    'The user wants to SCHEDULE a task to run on a recurring cadence (in ANY language).',
    'Extract exactly two fields:',
    '- cadence: a normalised schedule string, EXACTLY one of these two shapes —',
    '    "every <N><s|m|h|d>"  for an interval (e.g. "every 30m", "every 2h", "every 1d"),',
    '    "at HH:MM"            (24-hour clock) for a once-a-day time (e.g. "at 09:00").',
    '  Translate fuzzy cadences: "every morning"/"daily"/"each day"/"cada día" → "at 09:00";',
    '  "nightly"/"every night"/"cada noche" → "at 22:00"; "hourly"/"cada hora" → "every 1h";',
    '  "twice a day" → "every 12h"; "every other day" → "every 2d". Keep an explicit time as given.',
    "- task: the task to run, with the scheduling words removed, in the user's own language.",
    'Respond with ONLY a JSON object: {"cadence":"...","task":"..."} — no prose, no code fence.',
    '',
    `Request: ${text}`,
  ].join('\n');
}

/** Parses the model answer into a {@link ScheduleExtraction}; null if either field is missing. */
export function parseScheduleExtraction(modelOutput: string): ScheduleExtraction | null {
  const obj = firstJsonObject(modelOutput);
  if (obj === null) return null;
  const cadence = typeof obj.cadence === 'string' ? obj.cadence.trim() : '';
  const task = typeof obj.task === 'string' ? obj.task.trim() : '';
  if (cadence.length === 0 || task.length === 0) return null;
  return { cadence, task };
}

/** Extracts the cadence + task via the injected model; null on any fault (caller asks). */
export async function classifyScheduleExtraction(
  text: string,
  classify: IntentModel,
  signal?: AbortSignal,
): Promise<ScheduleExtraction | null> {
  try {
    return parseScheduleExtraction(await classify(buildScheduleExtractionPrompt(text), signal));
  } catch {
    return null;
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
