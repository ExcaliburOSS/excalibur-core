import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { DEFAULT_METHODOLOGIES, getDefaultMethodology } from './default-methodologies';
import { getDefaultWorkflow } from './default-workflows';
import { parseMethodologyYaml, validateMethodology } from './parse';

const EXPECTED_METHODOLOGY_IDS = [
  'lightweight',
  'review-first',
  'patch-proposal',
  'fast-fix',
  'plan-then-execute',
  'spec-driven',
  'tdd-agentic',
  'safe-refactor',
  'security-first',
  'migration',
  'explore-then-choose',
  'human-gated',
  'discovery',
  'agentic-agile-light',
];

const packageRoot = join(__dirname, '..');

describe('DEFAULT_METHODOLOGIES', () => {
  it('contains exactly the 14 contract methodologies in order', () => {
    expect(DEFAULT_METHODOLOGIES.map((entry) => entry.id)).toEqual(EXPECTED_METHODOLOGY_IDS);
  });

  it('every embedded YAML matches the mirrored file at the package root', () => {
    for (const entry of DEFAULT_METHODOLOGIES) {
      const filePath = join(packageRoot, 'default-methodologies', `${entry.id}.yaml`);
      expect(entry.yaml, `embedded YAML for ${entry.id} must match ${filePath}`).toBe(
        readFileSync(filePath, 'utf8'),
      );
    }
  });

  it('every default validates and matches its parsed YAML', () => {
    for (const entry of DEFAULT_METHODOLOGIES) {
      const result = validateMethodology(parseYaml(entry.yaml));
      expect(
        result.success,
        `methodology ${entry.id} must validate: ${result.errors?.join('; ')}`,
      ).toBe(true);
      expect(entry.definition).toEqual(parseMethodologyYaml(entry.yaml));
      expect(entry.definition.id).toBe(entry.id);
      expect(entry.definition.description.length).toBeGreaterThan(0);
    }
  });

  it('keeps the richer fields populated on every methodology', () => {
    for (const entry of DEFAULT_METHODOLOGIES) {
      const { definition } = entry;
      expect(definition.recommendedAutonomyLevels?.length, entry.id).toBeGreaterThan(0);
      expect(definition.useWhen?.length, entry.id).toBeGreaterThan(0);
      expect(definition.avoidWhen?.length, entry.id).toBeGreaterThan(0);
      expect(definition.defaultWorkflow, entry.id).toBeDefined();
      expect(definition.phases?.length, entry.id).toBeGreaterThan(0);
      expect(definition.riskProfile, entry.id).toBeDefined();
      expect(definition.category, entry.id).toBeDefined();
    }
  });

  it('every defaultWorkflow points at a built-in workflow', () => {
    for (const entry of DEFAULT_METHODOLOGIES) {
      const workflowId = entry.definition.defaultWorkflow;
      expect(
        workflowId !== undefined && getDefaultWorkflow(workflowId) !== undefined,
        `${entry.id} defaultWorkflow "${String(workflowId)}" must exist in DEFAULT_WORKFLOWS`,
      ).toBe(true);
    }
  });

  it('keeps the verbatim-normative spec-driven shape (OSS spec §8)', () => {
    const specDriven = getDefaultMethodology('spec-driven');
    expect(specDriven?.name).toBe('Spec-Driven Development');
    expect(specDriven?.recommendedAutonomyLevels).toEqual([3, 4]);
    expect(specDriven?.defaultWorkflow).toBe('structured-feature');
    expect(specDriven?.phases).toEqual([
      'understand',
      'specify',
      'plan',
      'implement',
      'verify',
      'review',
    ]);
    expect(specDriven?.artifacts).toEqual(['spec.md', 'plan.md', 'tasks.md', 'verification.md']);
    expect(specDriven?.agentRoles).toEqual(['planner', 'implementer', 'reviewer', 'tester']);
    expect(specDriven?.approval).toEqual({
      spec: 'optional',
      plan: 'optional',
      beforePr: 'recommended',
    });
    expect(specDriven?.riskProfile).toBe('medium');
    // The verbatim YAML omits category; the schema default applies.
    expect(specDriven?.category).toBe('delivery');
  });

  it('keeps the verbatim-normative discovery shape (Discovery spec §4)', () => {
    const discovery = getDefaultMethodology('discovery');
    expect(discovery?.category).toBe('pre_work');
    expect(discovery?.recommendedAutonomyLevels).toEqual([0, 1]);
    expect(discovery?.defaultWorkflow).toBe('discovery');
    expect(discovery?.phases).toEqual([
      'intake',
      'questions',
      'synthesis',
      'readiness',
      'recommendation',
    ]);
    expect(discovery?.outputs).toEqual([
      'discovery-summary.md',
      'refined-ticket.md',
      'acceptance-criteria.md',
      'mvp-scope.md',
      'readiness-assessment.md',
      'recommendation.md',
    ]);
    expect(discovery?.modes).toEqual([
      'product_idea',
      'existing_work_item',
      'customer_feedback',
      'technical_initiative',
      'incident',
      'agent_readiness',
      'mvp_scope',
    ]);
    expect(discovery?.questions?.map((question) => question.id)).toEqual([
      'problem',
      'user',
      'current_workaround',
      'urgency',
      'mvp',
      'out_of_scope',
      'success',
      'evidence',
      'readiness',
    ]);
    expect(discovery?.riskProfile).toBe('low');
  });

  it('keeps the agentic-agile-light shape (Onboarding spec §6)', () => {
    const agile = getDefaultMethodology('agentic-agile-light');
    expect(agile?.category).toBe('delivery');
    expect(agile?.recommendedAutonomyLevels).toEqual([0, 1]);
    expect(agile?.defaultWorkflow).toBe('ask-repo');
  });

  it('matches the OSS spec §7 autonomy table', () => {
    expect(getDefaultMethodology('lightweight')?.recommendedAutonomyLevels).toEqual([0, 1]);
    expect(getDefaultMethodology('review-first')?.recommendedAutonomyLevels).toEqual([0, 1, 2]);
    expect(getDefaultMethodology('patch-proposal')?.recommendedAutonomyLevels).toEqual([2]);
    expect(getDefaultMethodology('fast-fix')?.recommendedAutonomyLevels).toEqual([2, 3]);
    expect(getDefaultMethodology('plan-then-execute')?.recommendedAutonomyLevels).toEqual([3, 4]);
    expect(getDefaultMethodology('tdd-agentic')?.recommendedAutonomyLevels).toEqual([2, 3, 4]);
    expect(getDefaultMethodology('safe-refactor')?.recommendedAutonomyLevels).toEqual([2, 3, 4]);
    expect(getDefaultMethodology('security-first')?.recommendedAutonomyLevels).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(getDefaultMethodology('migration')?.recommendedAutonomyLevels).toEqual([3, 4]);
    expect(getDefaultMethodology('explore-then-choose')?.recommendedAutonomyLevels).toEqual([3, 4]);
    expect(getDefaultMethodology('human-gated')?.recommendedAutonomyLevels).toEqual([3, 4]);
  });
});

describe('getDefaultMethodology', () => {
  it('returns the definition for a known id', () => {
    expect(getDefaultMethodology('lightweight')?.name).toBe('Lightweight Assistant');
  });

  it('returns undefined for unknown ids', () => {
    expect(getDefaultMethodology('does-not-exist')).toBeUndefined();
  });
});
