import {
  askStructured,
  type JsonSchema,
  type StructuredChatRunner,
} from '../structured/structured-output';
import {
  MISSION_COMPLEXITIES,
  MISSION_RISKS,
  type Mission,
  type MissionComplexity,
  type MissionRisk,
} from './types';

/**
 * Step 1 of the meta-orchestrator: INTERPRET THE NEED. Turns a natural goal (any
 * language) plus light repo/session context into a structured {@link Mission} —
 * what the user really wants, how big/risky it is, what "done" means, and whether
 * it needs clarification or a read-only understanding pass first. This is what
 * lets the orchestrator be proactive: it sizes and shapes the work before
 * choosing capabilities. Provider-agnostic structured output (instruct + extract
 * + validate, Kimi-friendly); never throws — falls back to a safe default Mission.
 */

const MISSION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    interpretation: { type: 'string' },
    complexity: { type: 'string', enum: [...MISSION_COMPLEXITIES] },
    risk: { type: 'string', enum: [...MISSION_RISKS] },
    successCriteria: { type: 'array', items: { type: 'string' } },
    needsClarification: { type: 'boolean' },
    needsUnderstanding: { type: 'boolean' },
    parallelizable: { type: 'boolean' },
  },
  required: [
    'interpretation',
    'complexity',
    'risk',
    'successCriteria',
    'needsClarification',
    'needsUnderstanding',
    'parallelizable',
  ],
};

export interface InterpretMissionOptions {
  /** The structured chat surface (the gateway satisfies it). */
  gateway: StructuredChatRunner;
  /** Optional repo/session context (file map, recent activity) to ground sizing. */
  context?: string;
  /** Provider override (default: the gateway's default model). */
  provider?: string;
  signal?: AbortSignal;
}

/** Builds the interpretation question handed to the model. */
export function buildMissionQuestion(goal: string, context?: string): string {
  return [
    'You are the planning brain of an autonomous coding agent. Read the user GOAL (in ANY',
    'language) and interpret what they REALLY need, then size and shape the work so the agent',
    'can choose how to tackle it. Judge honestly:',
    '- interpretation: one sentence — the underlying need, not a restatement.',
    '- complexity: trivial | small | medium | large | epic.',
    '- risk: low | medium | high (data loss, security, user-facing, broad blast radius).',
    '- successCriteria: 1–5 concrete, checkable conditions that mean it is DONE.',
    '- needsClarification: true ONLY if the goal is genuinely ambiguous and building the wrong',
    '  thing is likely. Be conservative — do not ask when the intent is clear.',
    '- needsUnderstanding: true if the agent must read/map existing code before a plan is',
    '  trustworthy (almost always true for non-trivial changes to an existing codebase).',
    '- parallelizable: true if the work splits into INDEPENDENT pieces that could run at once.',
    ...(context !== undefined && context.length > 0 ? ['', 'Repository context:', context] : []),
    '',
    `GOAL: ${goal}`,
  ].join('\n');
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** A safe, conservative Mission when the model is unavailable or returns garbage. */
export function fallbackMission(goal: string): Mission {
  return {
    goal,
    interpretation: goal,
    complexity: 'medium',
    risk: 'medium',
    successCriteria: ['The stated goal is accomplished and the project still builds/tests.'],
    needsClarification: false,
    needsUnderstanding: true,
    parallelizable: false,
  };
}

/** Coerces a validated structured value into a {@link Mission} with safe defaults. */
export function coerceMission(value: unknown, goal: string): Mission {
  const v = (value ?? {}) as Record<string, unknown>;
  const fb = fallbackMission(goal);
  const complexity = MISSION_COMPLEXITIES.includes(v['complexity'] as MissionComplexity)
    ? (v['complexity'] as MissionComplexity)
    : fb.complexity;
  const risk = MISSION_RISKS.includes(v['risk'] as MissionRisk)
    ? (v['risk'] as MissionRisk)
    : fb.risk;
  const criteria =
    isStringArray(v['successCriteria']) && v['successCriteria'].length > 0
      ? v['successCriteria']
      : fb.successCriteria;
  return {
    goal,
    interpretation:
      typeof v['interpretation'] === 'string' && v['interpretation'].length > 0
        ? v['interpretation']
        : fb.interpretation,
    complexity,
    risk,
    successCriteria: criteria,
    needsClarification: v['needsClarification'] === true,
    // Default-true unless the model explicitly said false (understand-first is the
    // safe, proactive default for an existing codebase).
    needsUnderstanding: v['needsUnderstanding'] !== false,
    parallelizable: v['parallelizable'] === true,
  };
}

/** Interprets a natural goal into a structured {@link Mission}. Never throws. */
export async function interpretMission(
  goal: string,
  opts: InterpretMissionOptions,
): Promise<Mission> {
  const trimmed = goal.trim();
  if (trimmed.length === 0) {
    return fallbackMission(goal);
  }
  try {
    const result = await askStructured(opts.gateway, {
      question: buildMissionQuestion(trimmed, opts.context),
      schema: MISSION_SCHEMA,
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    return coerceMission(result.value, trimmed);
  } catch {
    return fallbackMission(trimmed);
  }
}
