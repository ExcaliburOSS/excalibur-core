/**
 * DISCOVERY-SHAPING (C) — the dynamic half of Discovery.
 *
 * The Discovery flow used to ask a STATIC `DISCOVERY_QUESTION_PACKS[inputType]`
 * set of generic questions. This module makes it adaptive: an injected model
 * reads the actual idea/ticket (in ANY language, NEVER via keyword/regex) and,
 * using the baseline pack as context, returns (1) clarifying questions TAILORED
 * to this specific input and (2) a MULTI-SELECT list of aspects/scope the user
 * may want to fold in (success metrics, target users, edge cases, constraints,
 * a rollout plan, …). It reuses the plan-shaping primitives (the multi-select TUI
 * + the JSON parsing/sanitizing helpers). Best-effort: any fault yields an EMPTY
 * shape, so Discovery falls back to the proven static pack.
 *
 * Unlike plan-shaping there is NO complexity/clarity gate: the user EXPLICITLY
 * invoked `excalibur discovery` to clarify, so we always tailor when we can.
 */

import { firstJsonObject, oneLine, type PlanRecommendation } from '../sessions/plan-shaping';
import type { IntentModel } from '../sessions/intent-router';

/** Tailored Discovery proposal: clarifying questions + togglable scope considerations. */
export interface DiscoveryShape {
  questions: string[];
  recommendations: PlanRecommendation[];
}

/** Minimal gate context — Discovery is opt-in, so only the technical gates apply. */
export interface DiscoveryShapeContext {
  /** A real human at a TTY who can answer (tailoring needs interaction). */
  interactive: boolean;
  /** The provider is the deterministic mock (no real model → never tailor). */
  mock: boolean;
}

const EMPTY: DiscoveryShape = { questions: [], recommendations: [] };

/** Builds the language-agnostic discovery-shaping prompt (the MODEL handles any language). */
export function buildDiscoveryShapePrompt(
  input: string,
  inputType: string,
  baseQuestions: readonly string[],
): string {
  const baseline =
    baseQuestions.length > 0 ? baseQuestions.map((q) => `- ${q}`).join('\n') : '(none)';
  return [
    'You help clarify a software idea/ticket BEFORE any building (a Discovery step).',
    'Read the input below in ANY language and reply IN THE SAME LANGUAGE as the input.',
    `The input is a "${inputType}". Here is the GENERIC baseline question pack for this type:`,
    baseline,
    '',
    'Produce a TAILORED clarification, specific to THIS input — do not just echo the baseline:',
    '1. "questions": up to 5 SHORT clarifying questions whose answers genuinely shape the scope.',
    '   Keep the baseline questions that are relevant, drop the ones the input already answers,',
    '   and ADD input-specific ones. Each must be answerable and decision-bearing.',
    '2. "recommendations": up to 6 aspects/scope the user might want to fold into this initiative',
    '   — e.g. success metrics, target users, non-goals, edge cases, constraints, dependencies,',
    '   risks, a rollout/validation plan. Each is {"title": short label, "detail": one phrase,',
    '   "recommended": true when it is a high-value/standard consideration for THIS input}.',
    'Return ONLY a JSON object: {"questions": string[], "recommendations": [{"title": string,',
    '"detail": string, "recommended": boolean}]}. No prose, no markdown, no code fences.',
    '',
    `Input:\n${input}`,
  ].join('\n');
}

/** Parses + sanitizes a model answer into a {@link DiscoveryShape} (≤5 Qs, ≤6 recs). */
export function parseDiscoveryShape(modelOutput: string): DiscoveryShape {
  const obj = firstJsonObject(modelOutput);
  if (obj === null) return EMPTY;
  const questions = (Array.isArray(obj['questions']) ? (obj['questions'] as unknown[]) : [])
    .map((q) => (typeof q === 'string' ? oneLine(q, 200) : ''))
    .filter((q) => q.length > 0)
    .slice(0, 5);
  const recommendations = (
    Array.isArray(obj['recommendations']) ? (obj['recommendations'] as unknown[]) : []
  )
    .map((r): PlanRecommendation | null => {
      if (typeof r !== 'object' || r === null) return null;
      const e = r as Record<string, unknown>;
      const title = typeof e['title'] === 'string' ? oneLine(e['title'], 80) : '';
      if (title.length === 0) return null;
      const detail = typeof e['detail'] === 'string' ? oneLine(e['detail'], 120) : '';
      return { title, detail, recommended: e['recommended'] === true };
    })
    .filter((r): r is PlanRecommendation => r !== null)
    .slice(0, 6);
  return { questions, recommendations };
}

/**
 * Proposes a tailored {@link DiscoveryShape} via the injected model. Gated on the
 * technical conditions only (a real interactive, non-mock turn with a non-empty
 * input); an empty shape otherwise. Never throws — any fault yields the empty
 * shape, so the caller falls back to the static question pack.
 */
export async function discoveryShape(
  input: string,
  inputType: string,
  baseQuestions: readonly string[],
  ctx: DiscoveryShapeContext,
  classify: IntentModel,
  signal?: AbortSignal,
): Promise<DiscoveryShape> {
  if (ctx.mock || !ctx.interactive || input.trim().length === 0) {
    return EMPTY;
  }
  try {
    return parseDiscoveryShape(
      await classify(buildDiscoveryShapePrompt(input, inputType, baseQuestions), signal),
    );
  } catch {
    return EMPTY;
  }
}
