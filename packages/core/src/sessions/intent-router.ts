import type { RepoAnalysis } from '@excalibur/context-engine';
import { type AutonomyLevel, type ExcaliburConfig } from '@excalibur/shared';
import {
  classifyTaskIntent,
  DEFAULT_SAFETY_PRESET_ID,
  SAFETY_PRESETS,
} from '../onboarding/onboarding';

/**
 * The pure, surface-agnostic intent router for the M-Shell REPL (Slice A):
 * given a line of user input it decides what the shell should do, NEVER
 * calling a model. Slash commands and `!shell` are recognised structurally;
 * everything else is a natural-language turn whose lane is derived by reusing
 * the deterministic {@link classifyTaskIntent} heuristics.
 */

/** The four conversational lanes a natural-language input can take. */
export type RouteLane = 'ask' | 'run' | 'discovery' | 'careful';

/** Context the router needs (no Ui, no model, no IO). */
export interface RouteContext {
  analysis: RepoAnalysis;
  config: ExcaliburConfig;
}

/** A discriminated decision describing how to dispatch one input line. */
export type RouteDecision =
  | { kind: 'command'; name: string; argv: string[] }
  | { kind: 'shell'; command: string }
  | {
      kind: 'natural';
      lane: RouteLane;
      /** The classified task type (e.g. `bugfix`, `feature`, `ambiguous`). */
      intent: string;
      /** Human-readable reason for the lane choice. */
      reason: string;
    };

/** Leading interrogatives that mark a question-shaped input. */
const INTERROGATIVE_LEAD =
  /^(what|why|how|when|where|who|which|is|are|do|does|did|can|could|should|would|will|whose|whom)\b/i;

/** Actionable verbs that override the "looks like a question" heuristic. */
const ACTIONABLE_LEAD =
  /^(add|fix|implement|build|create|refactor|rename|remove|delete|update|migrate|write|run|make|change|support|integrate|enable|introduce|generate|set ?up|wire)\b/i;

/**
 * True when the input reads like a question rather than a task: it ends with a
 * `?`, or it opens with an interrogative AND does not open with an actionable
 * verb. `"how do I add X?"` → question; `"add a retry to X"` → not.
 */
function isQuestionShaped(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.endsWith('?')) {
    return true;
  }
  return INTERROGATIVE_LEAD.test(trimmed) && !ACTIONABLE_LEAD.test(trimmed);
}

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
 * Routes one line of REPL input to a {@link RouteDecision}. Deterministic and
 * model-free:
 *
 * - leading `/` → a slash command (`/help`, `/exit`, …);
 * - leading `!` → a shell passthrough (recognised; execution deferred);
 * - otherwise a natural-language turn whose lane is mapped from
 *   {@link classifyTaskIntent}: discovery (ambiguous / discovery-first),
 *   ask (question-shaped, not an actionable verb), careful (sensitive),
 *   else run.
 */
export function routeInput(text: string, ctx: RouteContext): RouteDecision {
  const trimmed = text.trim();

  if (trimmed.startsWith('/')) {
    const [name, ...argv] = tokenize(trimmed.slice(1));
    return { kind: 'command', name: (name ?? '').toLowerCase(), argv };
  }

  if (trimmed.startsWith('!')) {
    return { kind: 'shell', command: trimmed.slice(1).trim() };
  }

  const intent = classifyTaskIntent(trimmed, ctx.analysis, ctx.config);

  // Question-shaped input (and not an actionable verb) → the ask lane. This
  // takes precedence over the discovery routing below: a clear question is
  // always answered read-only rather than triggering a discovery session,
  // even when the intent classifier would otherwise flag it ambiguous.
  if (isQuestionShaped(trimmed)) {
    return {
      kind: 'natural',
      lane: 'ask',
      intent: intent.taskType,
      reason: 'Question about the repository — answered read-only (never changes code).',
    };
  }

  const actionable = ACTIONABLE_LEAD.test(trimmed);

  // Discovery next: an ambiguous / discovery-first task is never run blind —
  // UNLESS it opens with an explicit imperative verb (an actionable command is
  // never sent to a clarifying discovery session).
  if ((intent.recommendDiscoveryFirst || intent.taskType === 'ambiguous') && !actionable) {
    return {
      kind: 'natural',
      lane: 'discovery',
      intent: intent.taskType,
      reason: intent.reason,
    };
  }

  // Sensitive areas → the careful lane (Level 4, stronger approvals).
  if (intent.sensitive) {
    return {
      kind: 'natural',
      lane: 'careful',
      intent: intent.taskType,
      reason: intent.reason,
    };
  }

  // Everything else is an actionable task → the run lane.
  return {
    kind: 'natural',
    lane: 'run',
    intent: intent.taskType,
    reason:
      intent.taskType === 'ambiguous'
        ? 'Actionable task — implemented in an isolated branch with approvals.'
        : intent.reason,
  };
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
