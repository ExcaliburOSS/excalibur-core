/**
 * PLAN-SHAPING (the co-creation step before a plan, à la Claude Code / Cursor).
 *
 * Given a build request, an injected model proposes — in the SAME language as the
 * request, NEVER via keyword/regex — (1) short clarifying questions whose answers
 * would change the plan, and (2) a list of RELATED / commonly-forgotten
 * developments the user might fold into the plan (tests, error handling, docs, a
 * migration, telemetry, a flag, validation, …), each flagged `recommended` when
 * it is high-value for THIS request. The CLI surfaces the recommendations as a
 * MULTI-SELECT (high-confidence pre-checked) + asks the questions; the user's
 * choices refine the plan scope.
 *
 * GATING (this is the whole point): the shaping UI must NOT appear for every
 * medium-sized or already-clear task — only when it genuinely helps. The model
 * grades the request's `complexity` (small | medium | large) and whether its
 * design is `clear`, and {@link shouldSurfacePlanShape} (a pure, tested gate)
 * decides whether to show anything at all: a large plan, an unclear design, or
 * real optional developments. A clear, self-contained small/medium task stays
 * SILENT — planning proceeds exactly as before. Best-effort: any fault yields an
 * EMPTY shape (which never surfaces).
 *
 * Core stays free of any model SDK — the call is injected (the REPL backs it with
 * the FAST model), mirroring `classifyTurnIntent` in `intent-router.ts`.
 */

import type { IntentContext, IntentModel } from './intent-router';

/** Coarse scope grade for a build request — drives the shaping gate. */
export type PlanComplexity = 'small' | 'medium' | 'large';

/** One proposed related/optional development the user can fold into the plan. */
export interface PlanRecommendation {
  /** Short label shown in the multi-select row. */
  title: string;
  /** One phrase of context (the dim hint). */
  detail: string;
  /** Pre-checked when true (a high-value/standard addition for this request). */
  recommended: boolean;
}

/** The shaping proposal: a scope grade + clarifying questions + togglable recommendations. */
export interface PlanShape {
  /** How big/involved this request is (model judgement). */
  complexity: PlanComplexity;
  /** Whether the design/approach is already unambiguous (model judgement). */
  clear: boolean;
  questions: string[];
  recommendations: PlanRecommendation[];
}

const EMPTY: PlanShape = { complexity: 'small', clear: true, questions: [], recommendations: [] };

/**
 * Decides whether the shaping proposal is worth interrupting the user for. Pure
 * and exhaustively tested. Surfaces ONLY when at least one is true:
 *   - the plan is LARGE/complex,
 *   - the design is NOT entirely clear (a clarifying question would change it),
 *   - there are genuine OPTIONAL developments to offer.
 * A SMALL task never shapes. A clear medium task with no optional scope stays
 * silent. In every case there must be something concrete (a question or a
 * recommendation) to actually show.
 */
export function shouldSurfacePlanShape(shape: PlanShape): boolean {
  // Nothing concrete to present → never interrupt.
  if (shape.questions.length === 0 && shape.recommendations.length === 0) return false;
  // A small, self-contained task does not warrant shaping.
  if (shape.complexity === 'small') return false;
  // Otherwise surface only on a real trigger: large plan, unclear design, or
  // genuine optional developments. A clear medium task with no extras → silent.
  return shape.complexity === 'large' || !shape.clear || shape.recommendations.length > 0;
}

/**
 * The ASYMMETRIC half of the gate: whether to actually ASK the clarifying
 * questions. Interrupting to type an answer is high-friction, so questions are
 * STRICT — only a large plan or a genuinely unclear design earns them. On a clear
 * medium task that surfaced purely for its low-friction recommendations, the
 * questions are suppressed (the user just toggles the pre-checked extras). This
 * keeps the question-asking structural, not merely dependent on the model.
 */
export function shouldAskPlanQuestions(shape: PlanShape): boolean {
  return shape.questions.length > 0 && (shape.complexity === 'large' || !shape.clear);
}

/** Builds the language-agnostic plan-shaping prompt (the MODEL handles any language). */
export function buildPlanShapePrompt(request: string): string {
  return [
    'You triage whether a coding agent should SHAPE a plan with the user BEFORE building.',
    'Read the build request in ANY language. Reply IN THE SAME LANGUAGE as the request.',
    '',
    'Return ONLY this JSON object (no prose, no markdown, no code fences):',
    '{',
    '  "complexity": "small" | "medium" | "large",',
    '  "clear": boolean,',
    '  "questions": string[],',
    '  "recommendations": [{"title": string, "detail": string, "recommended": boolean}]',
    '}',
    '',
    'Field rules:',
    '- "complexity": grade the WORK THE REQUEST IMPLIES, not the length of the sentence — a short',
    '  sentence can describe a huge system. Use this test, in order:',
    '    • "large" if the request asks to BUILD or substantially extend ANY of: authentication/',
    '      authorization, payments/billing, real-time / collaborative / sync / offline behavior,',
    '      multi-channel notifications, search / indexing, a data-model or schema change or',
    '      migration, or multiple services/integrations — OR to build a whole feature/subsystem',
    '      end-to-end. These inherently need scope/approach decisions.',
    '    • "small" = a single localized change (a rename, a copy tweak, one flag, one test, a',
    '      one-spot bug fix, a config value).',
    '    • "medium" = everything else: a contained feature in one area with an obvious approach.',
    '- "clear": true when the approach/design is unambiguous from the request. false when a KEY',
    '  design decision is unspecified and would materially change the plan (e.g. "add auth" does',
    '  not say which strategy; "add payments" does not name the processor or flows). A "large"',
    '  request is almost never fully "clear".',
    '- "questions": at MOST 3 short clarifying questions, and ONLY when the plan is "large" OR',
    '  "clear" is false. Each must be a decision that changes the plan. Otherwise return [].',
    '- "recommendations": at MOST 6 RELATED or commonly-forgotten developments worth folding in',
    '  (tests, error handling, input validation, docs, a migration, telemetry, a feature flag,',
    '  edge cases, rollback, webhooks, idempotency) — ONLY genuinely high-value ones that FIT',
    '  THIS request. Each: {"title": short label, "detail": one phrase, "recommended": true when',
    '  it is a standard/high-value addition here}.',
    '',
    'Grade complexity HONESTLY first. Then be conservative about CONTENT: a "small" or already-',
    'clear "medium" task needs NO interruption — return empty questions AND recommendations for it.',
    'Reserve questions/recommendations for "large" plans, unclear designs, or real optional scope.',
    '',
    'Example — small, clear (NO shaping):',
    'Request: Rename the variable `usr` to `user` in auth.ts',
    '{"complexity":"small","clear":true,"questions":[],"recommendations":[]}',
    '',
    'Example — large, unclear (DO shape):',
    'Request: Add a payment checkout flow integrating with a card processor',
    '{"complexity":"large","clear":false,"questions":["Which payment processor (Stripe, etc.)?",' +
      '"One-time charges or subscriptions?"],"recommendations":[{"title":"Webhook handling",' +
      '"detail":"confirm async payment status","recommended":true},{"title":"Idempotency keys",' +
      '"detail":"avoid double charges on retry","recommended":true},{"title":"Refund flow",' +
      '"detail":"handle reversals","recommended":false}]}',
    '',
    `Request: ${request}`,
  ].join('\n');
}

/** Extracts the first balanced JSON object from model output (fence/prose tolerant). */
function firstJsonObject(content: string): Record<string, unknown> | null {
  const start = content.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < content.length; i += 1) {
    const ch = content[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const value = JSON.parse(content.slice(start, i + 1)) as unknown;
          return typeof value === 'object' && value !== null
            ? (value as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Coerces an unknown value into a {@link PlanComplexity} (defaults to "medium"). */
function parseComplexity(value: unknown): PlanComplexity {
  return value === 'small' || value === 'large' ? value : 'medium';
}

/** Parses + sanitizes a model answer into a {@link PlanShape} (≤3 Qs, ≤6 recs). */
export function parsePlanShape(modelOutput: string): PlanShape {
  const obj = firstJsonObject(modelOutput);
  if (obj === null) return EMPTY;
  const complexity = parseComplexity(obj['complexity']);
  // Default to clear (silent) unless the model explicitly says the design is not.
  const clear = obj['clear'] !== false;
  const questions = (Array.isArray(obj['questions']) ? (obj['questions'] as unknown[]) : [])
    .map((q) => (typeof q === 'string' ? q.trim() : ''))
    .filter((q) => q.length > 0)
    .slice(0, 3);
  const recommendations = (
    Array.isArray(obj['recommendations']) ? (obj['recommendations'] as unknown[]) : []
  )
    .map((r): PlanRecommendation | null => {
      if (typeof r !== 'object' || r === null) return null;
      const e = r as Record<string, unknown>;
      const title = typeof e['title'] === 'string' ? e['title'].trim() : '';
      if (title.length === 0) return null;
      const detail = typeof e['detail'] === 'string' ? e['detail'].trim() : '';
      return { title, detail, recommended: e['recommended'] === true };
    })
    .filter((r): r is PlanRecommendation => r !== null)
    .slice(0, 6);
  return { complexity, clear, questions, recommendations };
}

/**
 * Proposes a {@link PlanShape} for a build request via the injected model. Gated
 * exactly like {@link classifyTurnIntent}: only for a real interactive,
 * act-capable, non-mock turn with a non-empty request; an empty shape (no
 * prompt) otherwise. Never throws — any fault yields the empty shape. Whether the
 * result is actually shown is a separate decision — see {@link shouldSurfacePlanShape}.
 */
export async function planShape(
  request: string,
  ctx: IntentContext,
  classify: IntentModel,
  signal?: AbortSignal,
): Promise<PlanShape> {
  if (ctx.mock || !ctx.interactive || ctx.level < 2 || request.trim().length === 0) {
    return EMPTY;
  }
  try {
    return parsePlanShape(await classify(buildPlanShapePrompt(request), signal));
  } catch {
    return EMPTY;
  }
}
