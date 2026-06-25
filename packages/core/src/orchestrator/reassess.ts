import {
  askStructured,
  type JsonSchema,
  type StructuredChatRunner,
} from '../structured/structured-output';
import {
  defaultReassess,
  type MissionState,
  type ReassessDecision,
  type Reassessor,
  type StepState,
} from './supervisor';
import { CAPABILITY_KINDS, type CapabilityKind } from './types';

/**
 * The model-backed {@link Reassessor} for the {@link runMission} supervisor — the
 * adaptive brain. After a step that warrants attention (a failure or a gate), it
 * looks at the goal, the plan so far, and what just happened, then decides whether
 * to continue, retry, ESCALATE a single agent to a swarm/best-of-N, REPLAN (splice
 * new steps), skip, abort, or declare the mission done. This is what turns a static
 * plan into an intelligent, self-correcting run. Provider-agnostic structured
 * output; never throws — falls back to the deterministic policy.
 */

const REASSESS_ACTIONS = [
  'continue',
  'retry',
  'escalate',
  'replan',
  'skip',
  'abort',
  'done',
] as const;

const PLAN_STEP_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    capability: { type: 'string', enum: [...CAPABILITY_KINDS] },
    objective: { type: 'string' },
    dependsOn: { type: 'array', items: { type: 'string' } },
    gate: { type: 'boolean' },
  },
  required: ['id', 'capability', 'objective', 'dependsOn', 'gate'],
};

const REASSESS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...REASSESS_ACTIONS] },
    reason: { type: 'string' },
    escalateTo: { type: 'string', enum: [...CAPABILITY_KINDS] },
    addSteps: { type: 'array', items: PLAN_STEP_SCHEMA },
  },
  required: ['action', 'reason'],
};

/** Renders the current plan with each step's status for the reassessment prompt. */
function renderProgress(state: Readonly<MissionState>): string {
  return state.steps
    .map(
      (s) =>
        `- [${s.status}] ${s.step.id} (${s.step.capability})${s.step.gate ? ' GATE' : ''}: ${s.step.objective}`,
    )
    .join('\n');
}

/** Builds the reassessment question handed to the model. */
export function buildReassessQuestion(
  state: Readonly<MissionState>,
  lastStep: Readonly<StepState>,
): string {
  return [
    'You are the adaptive supervisor of an autonomous coding mission. A step just finished and',
    'you must decide the next move. Be decisive and economical — do not over-react to a clean run.',
    '',
    `Mission goal: ${state.mission.goal}`,
    `Success criteria: ${state.mission.successCriteria.join('; ')}`,
    '',
    'Plan so far:',
    renderProgress(state),
    '',
    `The step that just finished: ${lastStep.step.id} (${lastStep.step.capability}) — ${lastStep.status}.`,
    `Result: ${lastStep.result?.summary ?? '(no summary)'}`,
    `Attempts so far: ${lastStep.attempts}.`,
    '',
    'Choose ONE action:',
    '- continue: accept this result and proceed with the plan (the right choice when a step',
    '  succeeded, or a non-critical step failed and the mission can still meet its criteria).',
    '- retry: re-run this exact step (only if a transient failure is plausible and attempts remain).',
    '- escalate: re-run this step with a STRONGER capability — set escalateTo to `parallelize`',
    '  (swarm, for independent sub-work) or `explore` (best-of-N, when the approach is uncertain).',
    '  Use when a single attempt struggled and more compute/parallelism would help.',
    '- replan: splice NEW steps into the remaining plan (set addSteps) — when you learned the work',
    '  needs steps the original plan missed (e.g. a discovered dependency, an extra verify).',
    '- skip: abandon this step as unnecessary and move on.',
    '- abort: stop the mission — a gate failed and recovery is not worthwhile, or it is unsafe.',
    '- done: the success criteria are already met; stop early.',
    '',
    'Give `action` and a one-sentence `reason`. Add `escalateTo` only for escalate, `addSteps`',
    'only for replan.',
  ].join('\n');
}

const isCapability = (v: unknown): v is CapabilityKind =>
  typeof v === 'string' && (CAPABILITY_KINDS as readonly string[]).includes(v);

/** Coerces a validated structured value into a {@link ReassessDecision}. */
export function coerceDecision(value: unknown, lastStep: Readonly<StepState>): ReassessDecision {
  const v = (value ?? {}) as Record<string, unknown>;
  const action = v['action'];
  if (!(REASSESS_ACTIONS as readonly string[]).includes(action as string)) {
    return defaultReassess(lastStep);
  }
  const reason =
    typeof v['reason'] === 'string' && v['reason'].length > 0 ? v['reason'] : 'reassessed';
  const decision: ReassessDecision = { action: action as ReassessDecision['action'], reason };
  if (decision.action === 'escalate' && isCapability(v['escalateTo'])) {
    decision.escalateTo = v['escalateTo'];
  }
  if (decision.action === 'replan' && Array.isArray(v['addSteps'])) {
    decision.addSteps = v['addSteps']
      .map((raw) => {
        const s = (raw ?? {}) as Record<string, unknown>;
        if (!isCapability(s['capability'])) return null;
        return {
          id: typeof s['id'] === 'string' ? s['id'] : '',
          capability: s['capability'],
          objective: typeof s['objective'] === 'string' ? s['objective'] : s['capability'],
          dependsOn: Array.isArray(s['dependsOn'])
            ? s['dependsOn'].filter((d): d is string => typeof d === 'string')
            : [],
          gate: s['gate'] === true,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
  }
  return decision;
}

export interface ReassessorOptions {
  gateway: StructuredChatRunner;
  provider?: string;
}

/** Builds a model-backed {@link Reassessor} (closes over the gateway). */
export function createReassessor(opts: ReassessorOptions): Reassessor {
  return async (state, lastStep, signal) => {
    try {
      const result = await askStructured(opts.gateway, {
        question: buildReassessQuestion(state, lastStep),
        schema: REASSESS_SCHEMA,
        ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
      return coerceDecision(result.value, lastStep);
    } catch {
      return defaultReassess(lastStep);
    }
  };
}
