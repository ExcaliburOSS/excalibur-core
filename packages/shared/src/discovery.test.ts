import { describe, expect, it } from 'vitest';
import {
  AGENT_READINESS_TO_AUTONOMY,
  DISCOVERY_ARTIFACT_FILES,
  discoveryRecordSchema,
  recommendFromScores,
  scoreDiscoveryTranscript,
  type DiscoveryAnswerEntry,
} from './discovery';

function entry(key: string, answer: string | null): DiscoveryAnswerEntry {
  return { key, question: key, answer };
}

/**
 * Behavior tests for the FROZEN deterministic Discovery contract
 * (`scoreDiscoveryTranscript` / `recommendFromScores`). These assert the
 * explainable rules the CLI readiness card depends on.
 */
describe('scoreDiscoveryTranscript', () => {
  it('scores an empty transcript as low/not_ready', () => {
    const scores = scoreDiscoveryTranscript({
      inputType: 'idea',
      inputMarkdown: 'Add a small improvement',
      answers: [],
    });
    expect(scores).toEqual({
      problemClarity: 'low',
      userEvidence: 'low',
      scopeClarity: 'low',
      technicalRisk: 'medium',
      agentReadiness: 'not_ready',
      touchesSensitivePaths: false,
    });
  });

  it('scores a fully-clarified, non-sensitive transcript as implementation_ready', () => {
    const scores = scoreDiscoveryTranscript({
      inputType: 'work_item',
      inputMarkdown: 'Webhook retries duplicate confirmation emails',
      answers: [
        entry('problem', 'Webhook retries cause duplicate order confirmation emails for merchants'),
        entry('user', 'Merchants on the standard tier who rely on email notifications'),
        entry('evidence', '14 support tickets from 9 customers reported this in the last month'),
        entry('mvp', 'Deduplicate sends with an idempotency token in the email worker'),
        entry('out_of_scope', 'No changes to the retry policy itself'),
        entry('risks', 'None identified, the email worker module is well covered by tests'),
      ],
    });
    expect(scores).toEqual({
      problemClarity: 'high',
      userEvidence: 'high',
      scopeClarity: 'high',
      technicalRisk: 'low',
      agentReadiness: 'implementation_ready',
      touchesSensitivePaths: false,
    });
  });

  it('flags sensitive domains anywhere in the transcript as high technical risk', () => {
    const scores = scoreDiscoveryTranscript({
      inputType: 'technical_initiative',
      inputMarkdown: 'Refactor the billing reconciliation job',
      answers: [
        entry('problem', 'The reconciliation job times out nightly and blocks invoice generation'),
        entry('user', 'Finance operations team members who close the books every morning'),
        entry('mvp', 'Batch the reconciliation queries and add a checkpoint'),
        entry('out_of_scope', 'No schema changes'),
      ],
    });
    expect(scores.touchesSensitivePaths).toBe(true);
    expect(scores.technicalRisk).toBe('high');
    // High risk caps readiness at plan_only even with clear scope.
    expect(scores.agentReadiness).toBe('plan_only');
  });

  it('treats uncertainty wording in risks as medium technical risk', () => {
    const scores = scoreDiscoveryTranscript({
      inputType: 'idea',
      inputMarkdown: 'Improve CSV export speed',
      answers: [
        entry('problem', 'Large CSV exports take minutes and block the browser tab for users'),
        entry('user', 'Data analysts exporting full project datasets every week'),
        entry('mvp', 'Stream the export in chunks'),
        entry('out_of_scope', 'No new export formats'),
        entry('risks', 'Unknown — we are unsure about memory side effects'),
      ],
    });
    expect(scores.technicalRisk).toBe('medium');
  });

  it('accepts the target_user fallback key for problem clarity', () => {
    const scores = scoreDiscoveryTranscript({
      inputType: 'idea',
      inputMarkdown: 'Faster onboarding',
      answers: [
        entry('problem', 'New workspace members cannot find the getting-started checklist'),
        entry('target_user', 'First-week employees joining an existing workspace with history'),
      ],
    });
    expect(scores.problemClarity).toBe('high');
  });

  it('requires quantified or customer-referencing evidence for high userEvidence', () => {
    const vague = scoreDiscoveryTranscript({
      inputType: 'customer_feedback',
      inputMarkdown: 'Feedback',
      answers: [entry('evidence', 'It feels like people want this and would enjoy having it soon')],
    });
    expect(vague.userEvidence).toBe('medium');

    const quantified = scoreDiscoveryTranscript({
      inputType: 'customer_feedback',
      inputMarkdown: 'Feedback',
      answers: [entry('evidence', 'Mentioned by 12 customers across 30 support conversations')],
    });
    expect(quantified.userEvidence).toBe('high');
  });

  it('scores scope medium with only an mvp and ignores null/empty answers', () => {
    const scores = scoreDiscoveryTranscript({
      inputType: 'work_item',
      inputMarkdown: 'Ticket',
      answers: [
        entry('mvp', 'Add a guard clause'),
        entry('out_of_scope', ''),
        entry('problem', null),
      ],
    });
    expect(scores.scopeClarity).toBe('medium');
    expect(scores.problemClarity).toBe('low');
  });
});

describe('recommendFromScores', () => {
  it('recommends refine_first at autonomy 0 when the problem is unclear', () => {
    const result = recommendFromScores({
      inputType: 'idea',
      problemClarity: 'low',
      userEvidence: 'low',
      scopeClarity: 'low',
      technicalRisk: 'medium',
      agentReadiness: 'not_ready',
    });
    expect(result.recommendation).toBe('refine_first');
    expect(result.recommendedAutonomyLevel).toBe(0);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('recommends customer_validation for customer feedback without evidence', () => {
    const result = recommendFromScores({
      inputType: 'customer_feedback',
      problemClarity: 'high',
      userEvidence: 'low',
      scopeClarity: 'high',
      technicalRisk: 'low',
      agentReadiness: 'implementation_ready',
    });
    expect(result.recommendation).toBe('customer_validation');
    expect(result.recommendedAutonomyLevel).toBe(3);
  });

  it('recommends prototype for product ideas without user evidence', () => {
    const result = recommendFromScores({
      inputType: 'idea',
      problemClarity: 'high',
      userEvidence: 'low',
      scopeClarity: 'medium',
      technicalRisk: 'low',
      agentReadiness: 'patch_ready',
    });
    expect(result.recommendation).toBe('prototype');
    expect(result.recommendedAutonomyLevel).toBe(2);
  });

  it('recommends split_scope when scope clarity is low', () => {
    const result = recommendFromScores({
      inputType: 'technical_initiative',
      problemClarity: 'high',
      userEvidence: 'medium',
      scopeClarity: 'low',
      technicalRisk: 'low',
      agentReadiness: 'plan_only',
    });
    expect(result.recommendation).toBe('split_scope');
    expect(result.recommendedAutonomyLevel).toBe(1);
  });

  it('recommends plan_only for high risk touching sensitive areas, technical_spike otherwise', () => {
    const base = {
      inputType: 'technical_initiative' as const,
      problemClarity: 'high' as const,
      userEvidence: 'medium' as const,
      scopeClarity: 'high' as const,
      technicalRisk: 'high' as const,
      agentReadiness: 'plan_only' as const,
    };
    const sensitive = recommendFromScores({ ...base, touchesSensitivePaths: true });
    expect(sensitive.recommendation).toBe('plan_only');
    expect(sensitive.recommendedAutonomyLevel).toBe(1);

    const nonSensitive = recommendFromScores({ ...base, touchesSensitivePaths: false });
    expect(nonSensitive.recommendation).toBe('technical_spike');
  });

  it('maps patch_ready readiness to the patch_ready recommendation at level 2', () => {
    const result = recommendFromScores({
      inputType: 'work_item',
      problemClarity: 'high',
      userEvidence: 'medium',
      scopeClarity: 'medium',
      technicalRisk: 'medium',
      agentReadiness: 'patch_ready',
    });
    expect(result.recommendation).toBe('patch_ready');
    expect(result.recommendedAutonomyLevel).toBe(2);
  });

  it('recommends agent_run_ready at level 3 for clear, low-risk, ready work', () => {
    const result = recommendFromScores({
      inputType: 'work_item',
      problemClarity: 'high',
      userEvidence: 'high',
      scopeClarity: 'high',
      technicalRisk: 'low',
      agentReadiness: 'implementation_ready',
      touchesSensitivePaths: false,
    });
    expect(result.recommendation).toBe('agent_run_ready');
    expect(result.recommendedAutonomyLevel).toBe(3);
  });

  it('escalates sensitive implementation_ready work to level 4 with approval gates', () => {
    const result = recommendFromScores({
      inputType: 'work_item',
      problemClarity: 'high',
      userEvidence: 'high',
      scopeClarity: 'high',
      technicalRisk: 'low',
      agentReadiness: 'implementation_ready',
      touchesSensitivePaths: true,
    });
    expect(result.recommendedAutonomyLevel).toBe(4);
    expect(result.reasons.some((r) => /sensitive/i.test(r))).toBe(true);
  });

  it('falls back to build_now for clear-enough work that is not fully high-confidence', () => {
    const result = recommendFromScores({
      inputType: 'technical_initiative',
      problemClarity: 'medium',
      userEvidence: 'medium',
      scopeClarity: 'high',
      technicalRisk: 'low',
      agentReadiness: 'implementation_ready',
    });
    expect(result.recommendation).toBe('build_now');
    expect(result.recommendedAutonomyLevel).toBe(3);
  });

  it('end-to-end: scoring output feeds recommendation without adaptation', () => {
    const scores = scoreDiscoveryTranscript({
      inputType: 'work_item',
      inputMarkdown: 'Fix the duplicated webhook email',
      answers: [
        entry('problem', 'Retries on the webhook consumer duplicate the confirmation email'),
        entry('user', 'Every merchant receiving order notifications through the email channel'),
        entry('evidence', 'Reproduced locally and reported in 6 tickets from 4 customers'),
        entry('mvp', 'Track processed webhook ids and skip duplicates'),
        entry('out_of_scope', 'No queue infrastructure changes'),
        entry('risks', 'Low, the consumer has integration tests'),
      ],
    });
    const result = recommendFromScores({ inputType: 'work_item', ...scores });
    expect(result.recommendation).toBe('agent_run_ready');
    expect(result.recommendedAutonomyLevel).toBe(3);
  });
});

describe('AGENT_READINESS_TO_AUTONOMY', () => {
  it('maps readiness to the spec autonomy levels', () => {
    expect(AGENT_READINESS_TO_AUTONOMY.not_ready).toEqual([0]);
    expect(AGENT_READINESS_TO_AUTONOMY.plan_only).toEqual([0, 1]);
    expect(AGENT_READINESS_TO_AUTONOMY.patch_ready).toEqual([2]);
    expect(AGENT_READINESS_TO_AUTONOMY.implementation_ready).toEqual([3, 4]);
  });
});

describe('discoveryRecordSchema / DISCOVERY_ARTIFACT_FILES', () => {
  it('validates a completed local discovery.json record', () => {
    const result = discoveryRecordSchema.safeParse({
      id: 'disc_20260612_143022',
      title: 'AI contract renewal reminders',
      inputType: 'idea',
      source: 'cli',
      status: 'completed',
      recommendation: 'prototype',
      problemClarity: 'high',
      userEvidence: 'low',
      scopeClarity: 'medium',
      technicalRisk: 'low',
      agentReadiness: 'patch_ready',
      recommendedAutonomyLevel: 2,
      createdAt: '2026-06-12T14:30:22Z',
      completedAt: '2026-06-12T14:40:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('lists the 9 discovery artifact files including discovery.json', () => {
    expect(DISCOVERY_ARTIFACT_FILES).toHaveLength(9);
    expect(DISCOVERY_ARTIFACT_FILES).toContain('discovery.json');
    expect(DISCOVERY_ARTIFACT_FILES).toContain('readiness-assessment.md');
  });
});
