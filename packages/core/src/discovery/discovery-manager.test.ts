import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS_CONFIG, ModelGateway } from '@excalibur/model-gateway';
import { DISCOVERY_ARTIFACT_FILES } from '@excalibur/shared';
import { DiscoverySessionNotFoundError } from '../errors';
import { makeTempDir, removeDir } from '../test-utils';
import { DiscoveryManager } from './discovery-manager';

describe('DiscoveryManager', () => {
  let repoRoot: string;
  let manager: DiscoveryManager;
  let gateway: ModelGateway;

  beforeEach(() => {
    repoRoot = makeTempDir();
    manager = new DiscoveryManager(repoRoot);
    gateway = new ModelGateway(DEFAULT_PROVIDERS_CONFIG);
  });

  afterEach(() => {
    removeDir(repoRoot);
  });

  it('runs a full session: create, answer, complete, artifacts and record', async () => {
    const session = manager.createSession({
      title: 'Add AI contract renewal reminders',
      inputType: 'idea',
      source: 'cli',
      inputMarkdown: 'Customers forget contract renewals and lose revenue.',
    });

    expect(session.id).toMatch(/^disc_\d{8}_\d{6}$/);
    expect(session.dir).toBe(join(repoRoot, '.excalibur', 'discovery', session.id));
    expect(session.record.status).toBe('open');
    expect(session.record.recommendation).toBeNull();
    expect(existsSync(join(session.dir, 'input.md'))).toBe(true);

    manager.recordAnswer(session.id, {
      key: 'user',
      question: 'Who specifically has this problem?',
      answer: 'Agency owners managing 20+ freelance contracts at the same time.',
    });
    manager.recordAnswer(session.id, {
      key: 'problem',
      question: 'What painful workflow are they experiencing?',
      answer: 'They track contract renewal dates in spreadsheets and miss deadlines monthly.',
    });
    manager.recordAnswer(session.id, {
      key: 'evidence',
      question: 'How often does this happen?',
      answer: '12 customers raised this in support tickets during the last quarter.',
    });
    manager.recordAnswer(session.id, {
      key: 'mvp',
      question: 'What is the smallest useful version?',
      answer: 'An email reminder 30 days before each contract end date.',
    });
    manager.recordAnswer(session.id, {
      key: 'out_of_scope',
      question: 'What is explicitly out of scope?',
      answer: 'Automatic renewal and e-signature flows.',
    });
    manager.recordAnswer(session.id, {
      key: 'risks',
      question: 'What would make this not worth building?',
      answer: 'Reminder fatigue if too many emails go out.',
    });

    const record = await manager.completeSession(session.id, gateway);

    expect(record.status).toBe('completed');
    expect(record.completedAt).not.toBeNull();
    expect(record.recommendation).not.toBeNull();
    expect(record.problemClarity).toBe('high');
    expect(record.scopeClarity).toBe('high');
    expect(record.userEvidence).toBe('high');
    expect(record.agentReadiness).not.toBeNull();
    expect(record.recommendedAutonomyLevel).not.toBeNull();

    // Every contract-pinned artifact file exists.
    for (const fileName of DISCOVERY_ARTIFACT_FILES) {
      expect(existsSync(join(session.dir, fileName)), fileName).toBe(true);
    }

    // The readiness card has the documented shape.
    const card = readFileSync(join(session.dir, 'readiness-assessment.md'), 'utf8');
    expect(card).toContain('Problem clarity: High');
    expect(card).toContain('User evidence: High');
    expect(card).toContain('Scope clarity: High');
    expect(card).toMatch(/Technical risk: (Low|Medium|High)/);
    expect(card).toMatch(/Agent readiness: /);
    expect(card).toMatch(/Recommended autonomy level: [0-4]/);
    expect(card).toMatch(/Recommended workflow: /);
    expect(card).toMatch(/Recommendation: /);

    // Synthesis came from the mock provider (honest banner).
    const summary = readFileSync(join(session.dir, 'discovery-summary.md'), 'utf8');
    expect(summary).toContain('Mock provider (M1)');
    expect(summary).toContain('Add AI contract renewal reminders');

    // The transcript captures every Q&A pair.
    const transcript = readFileSync(join(session.dir, 'transcript.md'), 'utf8');
    expect(transcript).toContain('Who specifically has this problem?');
    expect(transcript).toContain('Agency owners');

    // discovery.json reflects the completed record.
    const stored = JSON.parse(readFileSync(join(session.dir, 'discovery.json'), 'utf8')) as {
      status: string;
      recommendation: string | null;
    };
    expect(stored.status).toBe('completed');
    expect(stored.recommendation).toBe(record.recommendation);

    // getSession / listSessions round-trip.
    expect(manager.getSession(session.id).record.status).toBe('completed');
    expect(manager.listSessions().map((entry) => entry.id)).toContain(session.id);
  });

  it('keeps unanswered questions in the open-questions section', async () => {
    const session = manager.createSession({
      title: 'Vague idea',
      inputType: 'idea',
      source: 'cli',
      inputMarkdown: 'Something about dashboards.',
    });
    manager.recordAnswer(session.id, {
      key: 'problem',
      question: 'What problem are we trying to solve?',
      answer: null,
    });

    const record = await manager.completeSession(session.id, gateway);
    expect(record.problemClarity).toBe('low');
    expect(record.recommendation).toBe('refine_first');

    const summary = readFileSync(join(session.dir, 'discovery-summary.md'), 'utf8');
    expect(summary).toContain('Open questions');
    expect(summary).toContain('What problem are we trying to solve?');
  });

  it('throws DiscoverySessionNotFoundError for unknown ids', () => {
    expect(() => manager.getSession('disc_19700101_000000')).toThrowError(
      DiscoverySessionNotFoundError,
    );
    try {
      manager.getSession('disc_19700101_000000');
      expect.unreachable();
    } catch (error) {
      expect((error as DiscoverySessionNotFoundError).code).toBe('discovery_not_found');
    }
  });

  it('lists sessions and returns an empty list without .excalibur/', () => {
    expect(manager.listSessions()).toEqual([]);
  });
});
