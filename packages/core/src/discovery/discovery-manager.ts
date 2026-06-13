import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ChatMessage, ModelGateway } from '@excalibur/model-gateway';
import {
  createEvent,
  discoveryRecordSchema,
  recommendFromScores,
  scoreDiscoveryTranscript,
  serializeEventLine,
  type AgentReadiness,
  type DiscoveryAnswerEntry,
  type DiscoveryInputType,
  type DiscoveryRecord,
  type DiscoveryScore,
  type DiscoverySource,
} from '@excalibur/shared';
import { EXCALIBUR_DIR } from '../config/load-config';
import { ArtifactRecordError, DiscoverySessionNotFoundError } from '../errors';
import {
  appendLineEnsured,
  listSubdirectories,
  readTextIfExists,
  reserveTimestampDir,
  writeFileEnsured,
} from '../internal/fs-utils';
import { EffectiveInstructionBuilder } from '../instructions/effective-instructions';

/**
 * Local Discovery sessions (Build Contract §4.6, discovery-core.md §6):
 * `.excalibur/discovery/<disc_YYYYMMDD_HHMMSS>/` holds the input, the guided
 * Q&A transcript and — after `completeSession` — every artifact in
 * `DISCOVERY_ARTIFACT_FILES`. Scoring and recommendation are the frozen
 * deterministic rules from `@excalibur/shared`; the MockProvider only phrases
 * the synthesis text.
 */

export interface CreateDiscoverySessionInput {
  title: string;
  inputType: DiscoveryInputType;
  source: DiscoverySource;
  inputMarkdown: string;
}

export interface LocalDiscoverySession {
  id: string;
  dir: string;
  record: DiscoveryRecord;
}

const RECORD_FILE = 'discovery.json';
const ANSWERS_FILE = 'answers.json';
const EVENTS_FILE = 'events.jsonl';

const answersFileSchema = z.array(
  z.object({
    key: z.string().min(1),
    question: z.string().min(1),
    answer: z.string().nullable(),
  }),
);

function capitalizeScore(score: DiscoveryScore): string {
  return score.charAt(0).toUpperCase() + score.slice(1);
}

const READINESS_LABELS: Record<AgentReadiness, string> = {
  not_ready: 'Not ready',
  plan_only: 'Plan only',
  patch_ready: 'Patch ready',
  implementation_ready: 'Implementation ready',
};

/** Deterministic readiness → workflow key for the readiness card. */
function workflowForReadiness(readiness: AgentReadiness, autonomyLevel: number): string {
  switch (readiness) {
    case 'not_ready':
      return 'discovery';
    case 'plan_only':
      return 'assist';
    case 'patch_ready':
      return 'propose-patch';
    case 'implementation_ready':
      return autonomyLevel >= 4 ? 'structured-feature' : 'standard-feature';
  }
}

function answerLine(answer: DiscoveryAnswerEntry): string {
  const text = answer.answer !== null && answer.answer.trim().length > 0 ? answer.answer : '_(no answer)_';
  return `### ${answer.question}\n\n${text}`;
}

function answerFor(answers: DiscoveryAnswerEntry[], ...keys: string[]): string | null {
  for (const key of keys) {
    const found = answers.find((entry) => entry.key === key);
    if (found !== undefined && found.answer !== null && found.answer.trim().length > 0) {
      return found.answer.trim();
    }
  }
  return null;
}

export class DiscoveryManager {
  readonly repoRoot: string;
  private readonly discoveryDir: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
    this.discoveryDir = join(repoRoot, EXCALIBUR_DIR, 'discovery');
  }

  createSession(input: CreateDiscoverySessionInput): LocalDiscoverySession {
    // Atomic reservation: race-safe across parallel instances in the same repo.
    const { id, dir } = reserveTimestampDir(this.discoveryDir, 'disc');

    const record: DiscoveryRecord = {
      id,
      title: input.title,
      inputType: input.inputType,
      source: input.source,
      status: 'open',
      recommendation: null,
      problemClarity: null,
      userEvidence: null,
      scopeClarity: null,
      technicalRisk: null,
      agentReadiness: null,
      recommendedAutonomyLevel: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };

    this.writeRecord(dir, record);
    writeFileEnsured(join(dir, 'input.md'), `${input.inputMarkdown.trim()}\n`);
    writeFileEnsured(join(dir, ANSWERS_FILE), '[]\n');
    writeFileEnsured(join(dir, 'transcript.md'), `# Discovery transcript — ${input.title}\n`);

    return { id, dir, record };
  }

  recordAnswer(id: string, entry: DiscoveryAnswerEntry): void {
    const session = this.getSession(id);
    const answers = this.readAnswers(session.dir);
    answers.push(entry);
    writeFileEnsured(join(session.dir, ANSWERS_FILE), `${JSON.stringify(answers, null, 2)}\n`);
    this.writeTranscript(session.dir, session.record.title, answers);
  }

  async completeSession(id: string, gateway: ModelGateway): Promise<DiscoveryRecord> {
    const session = this.getSession(id);
    const answers = this.readAnswers(session.dir);
    const inputMarkdown = readTextIfExists(join(session.dir, 'input.md')) ?? '';

    // 1. Deterministic scoring + recommendation (frozen shared contract).
    const scores = scoreDiscoveryTranscript({
      inputType: session.record.inputType,
      inputMarkdown,
      answers,
    });
    const recommendation = recommendFromScores({
      inputType: session.record.inputType,
      problemClarity: scores.problemClarity,
      userEvidence: scores.userEvidence,
      scopeClarity: scores.scopeClarity,
      technicalRisk: scores.technicalRisk,
      agentReadiness: scores.agentReadiness,
      touchesSensitivePaths: scores.touchesSensitivePaths,
    });

    // 2. Effective instructions prepended to the synthesis prompts (ISD-5).
    const builder = new EffectiveInstructionBuilder({ repoRoot: this.repoRoot });
    const effective = await builder.build({ repositoryPath: this.repoRoot });
    // Frozen event enum has no `log` type: the ISD log event (spec §9)
    // travels as a `policy_decision` with `payload.kind = 'log'`.
    appendLineEnsured(
      join(session.dir, EVENTS_FILE),
      serializeEventLine(
        createEvent({
          runId: null,
          type: 'policy_decision',
          sessionId: id,
          payload: {
            kind: 'log',
            decision: 'allow',
            message: 'Effective instructions prepared for discovery synthesis.',
            instructionSources: effective.sources.map((source) => source.path),
            instructionWarnings: effective.warnings,
          },
        }),
      ),
    );

    const chat = async (kind: 'summary' | 'plan', userContent: string): Promise<string> => {
      const system =
        effective.instructionsMarkdown.length > 0
          ? `${effective.instructionsMarkdown}\n\nYou are the Excalibur discovery reviewer.`
          : 'You are the Excalibur discovery reviewer.';
      const messages: ChatMessage[] = [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ];
      const output = await gateway.chat({ messages, metadata: { kind, discoveryId: id } });
      return output.content;
    };

    const transcriptText = answers.map((entry) => `${entry.question} ${entry.answer ?? ''}`).join('\n');

    // 3. Synthesis artifacts (mock-phrased) + deterministic sections.
    const summarySynthesis = await chat(
      'summary',
      `Discovery synthesis for "${session.record.title}" (${session.record.inputType}).\n\nInput:\n${inputMarkdown}\n\nTranscript:\n${transcriptText}`,
    );
    const ticketSynthesis = await chat(
      'plan',
      `Turn the discovery session "${session.record.title}" into a refined, implementation-ready ticket.\n\nTranscript:\n${transcriptText}`,
    );

    const recommendedWorkflow = workflowForReadiness(
      scores.agentReadiness,
      recommendation.recommendedAutonomyLevel,
    );

    this.writeTranscript(session.dir, session.record.title, answers);
    writeFileEnsured(
      join(session.dir, 'discovery-summary.md'),
      this.renderSummary(session.record, answers, recommendation.recommendation, summarySynthesis),
    );
    writeFileEnsured(
      join(session.dir, 'refined-ticket.md'),
      this.renderRefinedTicket(session.record, answers, ticketSynthesis),
    );
    writeFileEnsured(
      join(session.dir, 'acceptance-criteria.md'),
      this.renderAcceptanceCriteria(session.record, answers),
    );
    writeFileEnsured(
      join(session.dir, 'mvp-scope.md'),
      this.renderMvpScope(session.record, answers),
    );
    writeFileEnsured(
      join(session.dir, 'readiness-assessment.md'),
      this.renderReadinessCard(session.record, scores, recommendation, recommendedWorkflow),
    );
    writeFileEnsured(
      join(session.dir, 'recommendation.md'),
      this.renderRecommendation(session.record, recommendation),
    );

    // 4. Final record.
    const completed: DiscoveryRecord = {
      ...session.record,
      status: 'completed',
      recommendation: recommendation.recommendation,
      problemClarity: scores.problemClarity,
      userEvidence: scores.userEvidence,
      scopeClarity: scores.scopeClarity,
      technicalRisk: scores.technicalRisk,
      agentReadiness: scores.agentReadiness,
      recommendedAutonomyLevel: recommendation.recommendedAutonomyLevel,
      completedAt: new Date().toISOString(),
    };
    this.writeRecord(session.dir, completed);
    return completed;
  }

  getSession(id: string): LocalDiscoverySession {
    const dir = join(this.discoveryDir, id);
    if (!existsSync(join(dir, RECORD_FILE))) {
      throw new DiscoverySessionNotFoundError(
        `Discovery session "${id}" was not found under ${this.discoveryDir}.`,
        { id },
      );
    }
    return { id, dir, record: this.readRecord(dir) };
  }

  listSessions(): LocalDiscoverySession[] {
    const sessions: LocalDiscoverySession[] = [];
    for (const name of listSubdirectories(this.discoveryDir)) {
      const dir = join(this.discoveryDir, name);
      try {
        sessions.push({ id: name, dir, record: this.readRecord(dir) });
      } catch {
        // Tolerant listing: corrupted sessions never break `status --discovery`.
      }
    }
    return sessions;
  }

  // --- rendering ---------------------------------------------------------------

  private renderSummary(
    record: DiscoveryRecord,
    answers: DiscoveryAnswerEntry[],
    recommendation: string,
    synthesis: string,
  ): string {
    const field = (label: string, ...keys: string[]): string =>
      `- **${label}:** ${answerFor(answers, ...keys) ?? '_unknown_'}`;
    const openQuestions = answers
      .filter((entry) => entry.answer === null || entry.answer.trim().length === 0)
      .map((entry) => `- ${entry.question}`);
    return [
      `# Discovery summary — ${record.title}`,
      '',
      field('Problem', 'problem'),
      field('User', 'user', 'segment'),
      field('Current workaround', 'current_workaround'),
      field('Evidence', 'evidence', 'verbatim'),
      field('Urgency', 'urgency', 'frequency'),
      field('Scope (MVP)', 'mvp'),
      field('Out of scope', 'out_of_scope'),
      '',
      '## Open questions',
      '',
      openQuestions.length > 0 ? openQuestions.join('\n') : '_None — every question was answered._',
      '',
      `## Recommendation`,
      '',
      `**${recommendation}**`,
      '',
      '## Synthesis',
      '',
      synthesis,
      '',
    ].join('\n');
  }

  private renderRefinedTicket(
    record: DiscoveryRecord,
    answers: DiscoveryAnswerEntry[],
    synthesis: string,
  ): string {
    return [
      `# ${record.title}`,
      '',
      `## Problem`,
      '',
      answerFor(answers, 'problem') ?? '_To be clarified._',
      '',
      '## Expected behavior',
      '',
      answerFor(answers, 'expected', 'success') ?? '_To be clarified._',
      '',
      '## Acceptance criteria',
      '',
      answerFor(answers, 'acceptance', 'success') ?? '_To be defined before implementation._',
      '',
      '## Scope',
      '',
      answerFor(answers, 'mvp') ?? '_To be defined._',
      '',
      '## Out of scope',
      '',
      answerFor(answers, 'out_of_scope') ?? '_To be defined._',
      '',
      '## Test expectations',
      '',
      answerFor(answers, 'tests') ?? '_To be defined._',
      '',
      '## Implementation notes',
      '',
      synthesis,
      '',
    ].join('\n');
  }

  private renderAcceptanceCriteria(
    record: DiscoveryRecord,
    answers: DiscoveryAnswerEntry[],
  ): string {
    const lines: string[] = [];
    const acceptance = answerFor(answers, 'acceptance');
    const success = answerFor(answers, 'success');
    const tests = answerFor(answers, 'tests');
    if (acceptance !== null) lines.push(`- [ ] ${acceptance}`);
    if (success !== null) lines.push(`- [ ] Success criteria: ${success}`);
    if (tests !== null) lines.push(`- [ ] Tests: ${tests}`);
    return [
      `# Acceptance criteria — ${record.title}`,
      '',
      lines.length > 0
        ? lines.join('\n')
        : '_No acceptance criteria captured yet — refine the ticket before implementation._',
      '',
    ].join('\n');
  }

  private renderMvpScope(record: DiscoveryRecord, answers: DiscoveryAnswerEntry[]): string {
    return [
      `# MVP Scope — ${record.title}`,
      '',
      '## In scope (first shippable version)',
      '',
      answerFor(answers, 'mvp') ?? '_To be defined._',
      '',
      '## Out of scope',
      '',
      answerFor(answers, 'out_of_scope', 'kill_criteria') ?? '_To be defined._',
      '',
      '## Later iterations',
      '',
      '_Defer anything not required by the first shippable version._',
      '',
      '## Overbuild risks',
      '',
      answerFor(answers, 'risks') ?? '_None recorded._',
      '',
    ].join('\n');
  }

  private renderReadinessCard(
    record: DiscoveryRecord,
    scores: ReturnType<typeof scoreDiscoveryTranscript>,
    recommendation: ReturnType<typeof recommendFromScores>,
    recommendedWorkflow: string,
  ): string {
    return [
      `# Readiness Assessment — ${record.title}`,
      '',
      '```text',
      `Problem clarity: ${capitalizeScore(scores.problemClarity)}`,
      `User evidence: ${capitalizeScore(scores.userEvidence)}`,
      `Scope clarity: ${capitalizeScore(scores.scopeClarity)}`,
      `Technical risk: ${capitalizeScore(scores.technicalRisk)}`,
      `Agent readiness: ${READINESS_LABELS[scores.agentReadiness]}`,
      `Recommended autonomy level: ${recommendation.recommendedAutonomyLevel}`,
      `Recommended workflow: ${recommendedWorkflow}`,
      `Recommendation: ${recommendation.recommendation}`,
      `Reason: ${recommendation.reasons.join(' ')}`,
      '```',
      '',
    ].join('\n');
  }

  private renderRecommendation(
    record: DiscoveryRecord,
    recommendation: ReturnType<typeof recommendFromScores>,
  ): string {
    return [
      `# Recommendation — ${record.title}`,
      '',
      `**${recommendation.recommendation}** (recommended autonomy level: ${recommendation.recommendedAutonomyLevel})`,
      '',
      '## Reasons',
      '',
      recommendation.reasons.map((reason) => `- ${reason}`).join('\n'),
      '',
    ].join('\n');
  }

  // --- persistence ---------------------------------------------------------------

  private writeTranscript(dir: string, title: string, answers: DiscoveryAnswerEntry[]): void {
    const body = answers.length > 0 ? `\n${answers.map(answerLine).join('\n\n')}\n` : '';
    writeFileEnsured(join(dir, 'transcript.md'), `# Discovery transcript — ${title}\n${body}`);
  }

  private writeRecord(dir: string, record: DiscoveryRecord): void {
    writeFileEnsured(join(dir, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
  }

  private readRecord(dir: string): DiscoveryRecord {
    const raw = readTextIfExists(join(dir, RECORD_FILE));
    if (raw === null) {
      throw new ArtifactRecordError(`Missing ${RECORD_FILE} in ${dir}.`, { dir });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ArtifactRecordError(`${RECORD_FILE} in ${dir} is not valid JSON: ${reason}`, {
        dir,
      });
    }
    const result = discoveryRecordSchema.safeParse(parsed);
    if (!result.success) {
      const problems = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new ArtifactRecordError(`Invalid ${RECORD_FILE} in ${dir}: ${problems}`, { dir });
    }
    return result.data;
  }

  private readAnswers(dir: string): DiscoveryAnswerEntry[] {
    const raw = readTextIfExists(join(dir, ANSWERS_FILE));
    if (raw === null) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    const result = answersFileSchema.safeParse(parsed);
    return result.success ? result.data : [];
  }
}
