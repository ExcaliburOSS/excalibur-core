import {
  askStructured,
  type JsonSchema,
  type StructuredChatRunner,
} from '../structured/structured-output';
import { topologicalWaves } from '../swarm/toposort';
import { renderCapabilityCatalog } from './capability-catalog';
import {
  CAPABILITY_KINDS,
  type CapabilityKind,
  type Mission,
  type OrchestrationPlan,
  type PlanStep,
} from './types';

/**
 * Step 2 of the meta-orchestrator: COMPOSE THE STRATEGY. Given an interpreted
 * {@link Mission} and the capability catalog, the planning model AUTHORS a
 * capability DAG — the right sequence/parallelism of understand → discover →
 * plan → implement|parallelize|explore → test → verify → review → ship. This is
 * the core of "use ALL functionalities proactively": the model picks from the
 * whole toolbox, and a deterministic normalizer guarantees the proactive
 * invariants (understand-first / clarify-when-ambiguous) and a valid, acyclic DAG.
 *
 * Provider-agnostic structured output; never throws — falls back to a sound
 * default plan when the model is unavailable or returns an unusable shape.
 */

const PLAN_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    rationale: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          capability: { type: 'string', enum: [...CAPABILITY_KINDS] },
          objective: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          gate: { type: 'boolean' },
        },
        required: ['id', 'capability', 'objective', 'dependsOn', 'gate'],
      },
    },
  },
  required: ['rationale', 'steps'],
};

export interface PlanStrategyOptions {
  gateway: StructuredChatRunner;
  /** Optional repo/session context to ground the plan. */
  context?: string;
  provider?: string;
  signal?: AbortSignal;
}

/** Builds the planning prompt: the mission + the capability menu + the rules. */
export function buildStrategyQuestion(mission: Mission, context?: string): string {
  return [
    'You are the planning brain of an autonomous coding agent. Compose a STRATEGY: an ordered',
    'plan of capability steps that fulfils the mission. You have these capabilities:',
    '',
    renderCapabilityCatalog(),
    '',
    'Rules:',
    '- Output a DAG: each step lists `dependsOn` (the ids of steps that must finish first).',
    '  Independent steps share dependencies and run in parallel; do NOT force a flat chain.',
    '- Start with `understand` (read-only recon) for any non-trivial change to existing code.',
    '- Include `discover` first ONLY if the goal is genuinely ambiguous.',
    '- Use `parallelize` only for genuinely INDEPENDENT pieces; `explore` only when the approach',
    '  is uncertain and worth comparing a few. Otherwise a single `implement` is right.',
    '- Gate (`gate: true`) the steps whose failure must STOP the mission (e.g. a failing',
    '  `verify` on a risky change). Match gating to the mission risk.',
    '- Add `test`/`verify`/`review` proportional to risk; do not over-engineer a small change.',
    '- Include `ship` ONLY if the goal asks to land/commit/PR the work.',
    '- Keep it tight: 3–8 steps, short objectives. Prefer the simplest plan that succeeds.',
    '',
    `Mission goal: ${mission.goal}`,
    `Interpretation: ${mission.interpretation}`,
    `Complexity: ${mission.complexity} · Risk: ${mission.risk} · Parallelizable: ${mission.parallelizable}`,
    `Needs clarification: ${mission.needsClarification} · Needs understanding: ${mission.needsUnderstanding}`,
    `Success criteria: ${mission.successCriteria.join('; ')}`,
    ...(context !== undefined && context.length > 0 ? ['', 'Repository context:', context] : []),
  ].join('\n');
}

const isCapability = (v: unknown): v is CapabilityKind =>
  typeof v === 'string' && (CAPABILITY_KINDS as readonly string[]).includes(v);

/** Coerces a raw structured value into clean {@link PlanStep}s (drops junk). */
function coerceSteps(value: unknown): PlanStep[] {
  const raw = value as { steps?: unknown };
  const list = Array.isArray(raw.steps) ? raw.steps : [];
  const seen = new Set<string>();
  const steps: PlanStep[] = [];
  for (const item of list) {
    const s = (item ?? {}) as Record<string, unknown>;
    if (!isCapability(s['capability'])) continue;
    let id = typeof s['id'] === 'string' && s['id'].length > 0 ? s['id'] : `s${steps.length + 1}`;
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);
    const objective =
      typeof s['objective'] === 'string' && s['objective'].length > 0
        ? s['objective']
        : s['capability'];
    const dependsOn = Array.isArray(s['dependsOn'])
      ? s['dependsOn'].filter((d): d is string => typeof d === 'string')
      : [];
    steps.push({ id, capability: s['capability'], objective, dependsOn, gate: s['gate'] === true });
  }
  // Drop dependencies that reference a non-existent step (dangling → never block).
  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    s.dependsOn = s.dependsOn.filter((d) => d !== s.id && ids.has(d));
  }
  return steps;
}

/**
 * Enforces the proactive invariants on a (possibly model-authored) step list:
 * a `discover` first when the mission is ambiguous, an `understand` before any
 * build step when understanding is needed, and at least one step that actually
 * DOES the work. Returns a valid, acyclic plan (falls back to linear if the model
 * produced a cycle).
 */
export function normalizePlan(steps: PlanStep[], mission: Mission): PlanStep[] {
  let out = [...steps];
  const has = (k: CapabilityKind): boolean => out.some((s) => s.capability === k);
  const firstId = (k: CapabilityKind): string | undefined =>
    out.find((s) => s.capability === k)?.id;

  // Ensure at least one capability that produces the change.
  if (!out.some((s) => ['implement', 'parallelize', 'explore'].includes(s.capability))) {
    out.push({
      id: 'implement',
      capability: 'implement',
      objective: mission.goal,
      dependsOn: [],
      gate: false,
    });
  }

  // understand-first: prepend a read-only recon and make the build steps depend on it.
  if (mission.needsUnderstanding && !has('understand')) {
    const understand: PlanStep = {
      id: 'understand',
      capability: 'understand',
      objective: `Map the code relevant to: ${mission.goal}`,
      dependsOn: [],
      gate: false,
    };
    for (const s of out) {
      if (['plan', 'implement', 'parallelize', 'explore'].includes(s.capability)) {
        if (s.dependsOn.length === 0) s.dependsOn = [understand.id];
      }
    }
    out = [understand, ...out];
  }

  // clarify-when-ambiguous: a discover step at the very front, everything roots after it.
  if (mission.needsClarification && !has('discover')) {
    const discover: PlanStep = {
      id: 'discover',
      capability: 'discover',
      objective: `Clarify the ambiguous parts of: ${mission.goal}`,
      dependsOn: [],
      gate: false,
    };
    for (const s of out) {
      if (s.dependsOn.length === 0) s.dependsOn = [discover.id];
    }
    out = [discover, ...out];
  }

  // A cycle is not safe to drive — degrade to a stable linear chain in array order.
  if (topologicalWaves(out) === null) {
    out = out.map((s, i) => ({ ...s, dependsOn: i === 0 ? [] : [out[i - 1]!.id] }));
  }
  void firstId; // (reserved for future explicit wiring; kept intentionally)
  return out;
}

/** A sound default plan when the model is unavailable: understand → implement → test (+verify). */
export function fallbackPlan(mission: Mission): OrchestrationPlan {
  const steps: PlanStep[] = [];
  if (mission.needsUnderstanding) {
    steps.push({
      id: 'understand',
      capability: 'understand',
      objective: `Map the code relevant to: ${mission.goal}`,
      dependsOn: [],
      gate: false,
    });
  }
  const buildDeps = steps.length > 0 ? [steps[0]!.id] : [];
  steps.push({
    id: 'implement',
    capability: 'implement',
    objective: mission.goal,
    dependsOn: buildDeps,
    gate: false,
  });
  steps.push({
    id: 'test',
    capability: 'test',
    objective: 'Run the test suite and confirm nothing regressed.',
    dependsOn: ['implement'],
    gate: mission.risk !== 'low',
  });
  if (mission.risk === 'high') {
    steps.push({
      id: 'verify',
      capability: 'verify',
      objective: 'Adversarially verify the change is correct and complete.',
      dependsOn: ['test'],
      gate: true,
    });
  }
  return {
    goal: mission.goal,
    steps,
    rationale: 'Default strategy (model unavailable): understand the code, implement, then test.',
  };
}

/** Composes an {@link OrchestrationPlan} from a {@link Mission}. Never throws. */
export async function planStrategy(
  mission: Mission,
  opts: PlanStrategyOptions,
): Promise<OrchestrationPlan> {
  try {
    const result = await askStructured(opts.gateway, {
      question: buildStrategyQuestion(mission, opts.context),
      schema: PLAN_SCHEMA,
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    const steps = normalizePlan(coerceSteps(result.value), mission);
    if (steps.length === 0) {
      return fallbackPlan(mission);
    }
    const rationale =
      typeof (result.value as { rationale?: unknown })?.rationale === 'string' &&
      (result.value as { rationale: string }).rationale.length > 0
        ? (result.value as { rationale: string }).rationale
        : fallbackPlan(mission).rationale;
    return { goal: mission.goal, steps, rationale };
  } catch {
    return fallbackPlan(mission);
  }
}
