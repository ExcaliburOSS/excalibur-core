import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKFLOWS, getDefaultWorkflow } from './default-workflows';
import { parseWorkflowYaml, validateWorkflowDefinition } from './parse';

const EXPECTED_WORKFLOW_IDS = [
  'ask-repo',
  'review-only',
  'assist',
  'propose-patch',
  'fast-fix',
  'standard-feature',
  'structured-feature',
  'safe-refactor',
  'pr-review',
  'security-review',
  'migration',
  'explore-alternatives',
  'human-gated',
  'discovery',
];

const packageRoot = join(__dirname, '..');

describe('DEFAULT_WORKFLOWS', () => {
  it('contains exactly the 14 contract workflows in order', () => {
    expect(DEFAULT_WORKFLOWS.map((entry) => entry.id)).toEqual(EXPECTED_WORKFLOW_IDS);
  });

  it('every embedded YAML matches the mirrored file at the package root', () => {
    for (const entry of DEFAULT_WORKFLOWS) {
      const filePath = join(packageRoot, 'default-workflows', `${entry.id}.yaml`);
      expect(entry.yaml, `embedded YAML for ${entry.id} must match ${filePath}`).toBe(
        readFileSync(filePath, 'utf8'),
      );
    }
  });

  it('every default validates and matches its parsed YAML', () => {
    for (const entry of DEFAULT_WORKFLOWS) {
      const result = validateWorkflowDefinition(parseYaml(entry.yaml));
      expect(result.success, `workflow ${entry.id} must validate: ${result.errors?.join('; ')}`).toBe(
        true,
      );
      expect(entry.definition).toEqual(parseWorkflowYaml(entry.yaml));
      expect(entry.definition.id).toBe(entry.id);
      expect(entry.definition.phases.length).toBeGreaterThan(0);
      expect(entry.definition.supportedAutonomyLevels?.length).toBeGreaterThan(0);
    }
  });

  it('keeps the verbatim-normative fast-fix shape (OSS spec §9)', () => {
    const fastFix = getDefaultWorkflow('fast-fix');
    expect(fastFix?.mode).toBe('fast');
    expect(fastFix?.supportedAutonomyLevels).toEqual([2, 3]);
    expect(fastFix?.phases.map((phase) => phase.id)).toEqual([
      'analyze',
      'patch',
      'optional_apply',
      'verify',
      'summarize',
    ]);
    const verify = fastFix?.phases.find((phase) => phase.id === 'verify');
    expect(verify?.optional).toBe(true);
    expect(verify?.required).toBe(false);
    expect(verify?.commandsFromConfig).toBe(true);
    const apply = fastFix?.phases.find((phase) => phase.id === 'optional_apply');
    expect(apply?.type).toBe('apply_patch');
    expect(apply?.requiresHumanConfirmation).toBe(true);
  });

  it('keeps the verbatim-normative structured-feature shape (OSS spec §9)', () => {
    const structured = getDefaultWorkflow('structured-feature');
    expect(structured?.mode).toBe('structured');
    expect(structured?.supportedAutonomyLevels).toEqual([3, 4]);
    expect(structured?.phases.map((phase) => phase.id)).toEqual([
      'context',
      'spec',
      'plan',
      'implement',
      'verify',
      'review',
      'pr_summary',
    ]);
    const implement = structured?.phases.find((phase) => phase.id === 'implement');
    expect(implement?.type).toBe('agent_work');
    expect(implement?.worktree).toBe(true);
    expect(implement?.agents).toBe(1);
  });

  it('keeps the verbatim-normative explore-alternatives shape (OSS spec §9)', () => {
    const explore = getDefaultWorkflow('explore-alternatives');
    expect(explore?.mode).toBe('explore');
    expect(explore?.phases.map((phase) => phase.id)).toEqual([
      'understand',
      'alternatives',
      'choose',
      'implement',
      'verify',
      'summarize',
    ]);
    const choose = explore?.phases.find((phase) => phase.id === 'choose');
    expect(choose?.type).toBe('human_approval');
    expect(choose?.required).toBe(false);
  });

  it('keeps the verbatim-normative discovery shape (Discovery spec §5)', () => {
    const discovery = getDefaultWorkflow('discovery');
    expect(discovery?.mode).toBe('discovery');
    expect(discovery?.supportedAutonomyLevels).toEqual([0, 1]);
    expect(discovery?.phases.map((phase) => phase.id)).toEqual([
      'intake',
      'questions',
      'synthesis',
      'readiness',
      'recommendation',
    ]);
    expect(discovery?.phases.find((phase) => phase.id === 'questions')?.type).toBe(
      'discovery_questions',
    );
    expect(discovery?.phases.every((phase) => phase.modifiesFiles === false)).toBe(true);
  });

  it('keeps the ask-repo shape (Onboarding spec §6)', () => {
    const askRepo = getDefaultWorkflow('ask-repo');
    expect(askRepo?.mode).toBe('fast');
    expect(askRepo?.supportedAutonomyLevels).toEqual([1]);
    expect(askRepo?.phases).toHaveLength(1);
    const phase = askRepo?.phases[0];
    expect(phase?.type).toBe('assistant_interaction');
    expect(phase?.role).toBe('planner');
    expect(phase?.output).toBe('answer.md');
    expect(phase?.modifiesFiles).toBe(false);
  });

  it('keeps the pinned human-gated phase sequence', () => {
    const humanGated = getDefaultWorkflow('human-gated');
    expect(humanGated?.phases.map((phase) => phase.type)).toEqual([
      'agent_output',
      'human_approval',
      'agent_work',
      'command_group',
      'human_approval',
      'pull_request',
    ]);
    const approvals = humanGated?.phases.filter((phase) => phase.type === 'human_approval');
    expect(approvals?.every((phase) => phase.approval === 'required')).toBe(true);
  });

  it('adds a Document phase after Verify to the code-shipping workflows', () => {
    for (const id of ['standard-feature', 'safe-refactor', 'migration', 'security-review']) {
      const phases = getDefaultWorkflow(id)?.phases ?? [];
      const ids = phases.map((phase) => phase.id);
      expect(ids, `${id} must include a document phase`).toContain('document');
      const document = phases.find((phase) => phase.id === 'document');
      expect(document?.type).toBe('agent_work');
      // Documentation comes after the change is verified so docs reflect reality.
      expect(ids.indexOf('document')).toBeGreaterThan(ids.indexOf('verify'));
    }
  });
});

describe('getDefaultWorkflow', () => {
  it('returns the definition for a known id', () => {
    expect(getDefaultWorkflow('review-only')?.name).toBe('Review Only');
  });

  it('returns undefined for unknown ids', () => {
    expect(getDefaultWorkflow('does-not-exist')).toBeUndefined();
  });
});
