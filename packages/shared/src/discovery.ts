import { z } from 'zod';
import { AUTONOMY_LEVELS, autonomyLevelSchema, type AutonomyLevel } from './autonomy';

/**
 * Discovery contract (Discovery spec §9, §20, §21).
 *
 * Discovery is the lightweight pre-work methodology that clarifies ideas, tickets,
 * feedback or technical initiatives before implementation. The scoring and
 * recommendation logic is DETERMINISTIC and lives here so that Excalibur Core
 * (local CLI sessions) and Excalibur Enterprise (DiscoverySession services) apply
 * exactly the same explainable rules. AI may phrase summaries; it never decides.
 */

export const discoveryInputTypeSchema = z.enum([
  'idea',
  'work_item',
  'customer_feedback',
  'technical_initiative',
  'incident',
  'agent_readiness',
  'mvp_scope',
  'other',
]);
export type DiscoveryInputType = z.infer<typeof discoveryInputTypeSchema>;

export const discoverySourceSchema = z.enum([
  'web',
  'cli',
  'slack',
  'teams',
  'linear',
  'jira',
  'github',
  'gitlab',
]);
export type DiscoverySource = z.infer<typeof discoverySourceSchema>;

export const discoveryRecommendationSchema = z.enum([
  'build_now',
  'refine_first',
  'split_scope',
  'customer_validation',
  'prototype',
  'technical_spike',
  'plan_only',
  'patch_ready',
  'agent_run_ready',
  'do_not_build',
]);
export type DiscoveryRecommendation = z.infer<typeof discoveryRecommendationSchema>;

export const discoveryScoreSchema = z.enum(['low', 'medium', 'high']);
export type DiscoveryScore = z.infer<typeof discoveryScoreSchema>;

export const agentReadinessSchema = z.enum([
  'not_ready',
  'plan_only',
  'patch_ready',
  'implementation_ready',
]);
export type AgentReadiness = z.infer<typeof agentReadinessSchema>;

/** Readiness → allowed autonomy levels (Discovery spec §9). */
export const AGENT_READINESS_TO_AUTONOMY: Record<AgentReadiness, readonly AutonomyLevel[]> = {
  not_ready: [AUTONOMY_LEVELS.REVIEW],
  plan_only: [AUTONOMY_LEVELS.REVIEW, AUTONOMY_LEVELS.ASSIST],
  patch_ready: [AUTONOMY_LEVELS.PROPOSE_PATCH],
  implementation_ready: [AUTONOMY_LEVELS.IMPLEMENT_IN_BRANCH, AUTONOMY_LEVELS.FULL_AGENTIC],
};

export interface DiscoveryScores {
  problemClarity: DiscoveryScore;
  userEvidence: DiscoveryScore;
  scopeClarity: DiscoveryScore;
  technicalRisk: DiscoveryScore;
}

export interface DiscoveryAnswerEntry {
  key: string;
  question: string;
  answer: string | null;
}

/** Local discovery.json record (Discovery spec §18). */
export const discoveryRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  inputType: discoveryInputTypeSchema,
  source: discoverySourceSchema,
  status: z.enum(['open', 'completed', 'cancelled']),
  recommendation: discoveryRecommendationSchema.nullable(),
  problemClarity: discoveryScoreSchema.nullable(),
  userEvidence: discoveryScoreSchema.nullable(),
  scopeClarity: discoveryScoreSchema.nullable(),
  technicalRisk: discoveryScoreSchema.nullable(),
  agentReadiness: agentReadinessSchema.nullable(),
  recommendedAutonomyLevel: autonomyLevelSchema.nullable(),
  createdAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).nullable(),
});
export type DiscoveryRecord = z.infer<typeof discoveryRecordSchema>;

export const DISCOVERY_ARTIFACT_FILES = [
  'input.md',
  'transcript.md',
  'discovery-summary.md',
  'refined-ticket.md',
  'acceptance-criteria.md',
  'mvp-scope.md',
  'readiness-assessment.md',
  'recommendation.md',
  'discovery.json',
] as const;

const SENSITIVE_HINTS = [
  'auth',
  'billing',
  'payment',
  'migration',
  'security',
  'secret',
  'pii',
  'compliance',
  'legal',
  'escrow',
];

const SUBSTANTIAL_ANSWER = 30;

function answerFor(answers: DiscoveryAnswerEntry[], ...keys: string[]): string {
  for (const key of keys) {
    const found = answers.find((a) => a.key === key);
    if (found?.answer && found.answer.trim().length > 0) return found.answer.trim();
  }
  return '';
}

function mentionsSensitive(text: string): boolean {
  const lower = text.toLowerCase();
  return SENSITIVE_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Deterministic transcript scoring (Discovery spec §9). Question keys follow the
 * default question packs: problem, user, current_workaround, urgency, mvp,
 * out_of_scope, success, evidence, risks, readiness (packs may add more; scoring
 * only inspects these well-known keys plus the raw input).
 */
export function scoreDiscoveryTranscript(input: {
  inputType: DiscoveryInputType;
  inputMarkdown: string;
  answers: DiscoveryAnswerEntry[];
}): DiscoveryScores & { agentReadiness: AgentReadiness; touchesSensitivePaths: boolean } {
  const { answers } = input;

  const problem = answerFor(answers, 'problem');
  const user = answerFor(answers, 'user', 'target_user');
  const problemSubstantial = problem.length >= SUBSTANTIAL_ANSWER;
  const userSubstantial = user.length >= SUBSTANTIAL_ANSWER;
  const problemClarity: DiscoveryScore =
    problemSubstantial && userSubstantial
      ? 'high'
      : problem.length > 0 || user.length > 0
        ? 'medium'
        : 'low';

  const evidence = answerFor(answers, 'evidence');
  const hasQuantifiedEvidence = /\d/.test(evidence) || /customer|user|client|ticket/i.test(evidence);
  const userEvidence: DiscoveryScore =
    evidence.length >= SUBSTANTIAL_ANSWER && hasQuantifiedEvidence
      ? 'high'
      : evidence.length > 0
        ? 'medium'
        : 'low';

  const mvp = answerFor(answers, 'mvp');
  const outOfScope = answerFor(answers, 'out_of_scope');
  const scopeClarity: DiscoveryScore =
    mvp.length > 0 && outOfScope.length > 0 ? 'high' : mvp.length > 0 ? 'medium' : 'low';

  const allText = [input.inputMarkdown, ...answers.map((a) => a.answer ?? '')].join('\n');
  const risks = answerFor(answers, 'risks', 'readiness');
  const touchesSensitivePaths = mentionsSensitive(allText);
  const technicalRisk: DiscoveryScore = touchesSensitivePaths
    ? 'high'
    : /unknown|unsure|not sure|no idea|risky/i.test(risks)
      ? 'medium'
      : risks.length > 0 || scopeClarity === 'high'
        ? 'low'
        : 'medium';

  let agentReadiness: AgentReadiness;
  if (scopeClarity === 'high' && problemClarity !== 'low' && technicalRisk === 'low') {
    agentReadiness = 'implementation_ready';
  } else if (scopeClarity !== 'low' && technicalRisk !== 'high') {
    agentReadiness = 'patch_ready';
  } else if (problemClarity !== 'low') {
    agentReadiness = 'plan_only';
  } else {
    agentReadiness = 'not_ready';
  }

  return { problemClarity, userEvidence, scopeClarity, technicalRisk, agentReadiness, touchesSensitivePaths };
}

export interface DiscoveryRecommendationInput extends DiscoveryScores {
  inputType: DiscoveryInputType;
  agentReadiness: AgentReadiness;
  touchesSensitivePaths?: boolean;
}

export interface DiscoveryRecommendationResult {
  recommendation: DiscoveryRecommendation;
  recommendedAutonomyLevel: AutonomyLevel;
  reasons: string[];
}

/**
 * Deterministic recommendation rules, evaluated in priority order (Discovery spec §21).
 */
export function recommendFromScores(
  input: DiscoveryRecommendationInput,
): DiscoveryRecommendationResult {
  const reasons: string[] = [];
  let recommendation: DiscoveryRecommendation;

  if (input.problemClarity === 'low') {
    recommendation = 'refine_first';
    reasons.push('Problem clarity is low — the target user or problem is not yet clear.');
  } else if (input.inputType === 'customer_feedback' && input.userEvidence === 'low') {
    recommendation = 'customer_validation';
    reasons.push('Customer feedback with low evidence — validate with customers before building.');
  } else if (input.inputType === 'idea' && input.userEvidence === 'low') {
    recommendation = 'prototype';
    reasons.push('Product idea with low user evidence — a lightweight prototype is cheaper than a full build.');
  } else if (input.scopeClarity === 'low') {
    recommendation = 'split_scope';
    reasons.push('Scope clarity is low — split or refine the scope before implementation.');
  } else if (input.technicalRisk === 'high') {
    recommendation = input.touchesSensitivePaths ? 'plan_only' : 'technical_spike';
    reasons.push(
      input.touchesSensitivePaths
        ? 'High technical risk touching sensitive areas — plan first, with human approval gates.'
        : 'High technical risk — run a technical spike before committing to delivery.',
    );
  } else if (input.agentReadiness === 'not_ready') {
    recommendation = 'refine_first';
    reasons.push('The task is not ready for AI execution — refine it first.');
  } else if (input.agentReadiness === 'plan_only') {
    recommendation = 'plan_only';
    reasons.push('AI can plan this safely, but should not modify code yet.');
  } else if (input.agentReadiness === 'patch_ready') {
    recommendation = 'patch_ready';
    reasons.push('AI can safely propose a patch; a human should review and apply it.');
  } else if (
    input.problemClarity === 'high' &&
    input.scopeClarity === 'high' &&
    input.technicalRisk === 'low'
  ) {
    recommendation = 'agent_run_ready';
    reasons.push('Clear problem, clear scope and low risk — ready for an agentic run.');
  } else {
    recommendation = 'build_now';
    reasons.push('The work is clear and valuable enough to proceed.');
  }

  let recommendedAutonomyLevel: AutonomyLevel;
  switch (input.agentReadiness) {
    case 'not_ready':
      recommendedAutonomyLevel = AUTONOMY_LEVELS.REVIEW;
      break;
    case 'plan_only':
      recommendedAutonomyLevel = AUTONOMY_LEVELS.ASSIST;
      break;
    case 'patch_ready':
      recommendedAutonomyLevel = AUTONOMY_LEVELS.PROPOSE_PATCH;
      break;
    case 'implementation_ready':
      if (input.touchesSensitivePaths) {
        recommendedAutonomyLevel = AUTONOMY_LEVELS.FULL_AGENTIC;
        reasons.push('Sensitive areas involved — use Level 4 with human approval gates.');
      } else {
        recommendedAutonomyLevel = AUTONOMY_LEVELS.IMPLEMENT_IN_BRANCH;
      }
      break;
  }

  return { recommendation, recommendedAutonomyLevel, reasons };
}
