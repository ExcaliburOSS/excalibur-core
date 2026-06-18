import { describe, expect, it } from 'vitest';
import type { AutonomyLevel, ExcaliburConfig, ExecutionStyle } from '@excalibur/shared';
import { DEFAULT_WORKFLOWS } from '@excalibur/workflow-schema';
import { selectWorkflow } from './select-workflow';

const catalog = DEFAULT_WORKFLOWS.map((entry) => ({ id: entry.id, definition: entry.definition }));

function select(input: {
  autonomyLevel: AutonomyLevel;
  executionStyle: ExecutionStyle;
  taskType?: string;
  paths?: string[];
  explicitWorkflow?: string;
  config?: ExcaliburConfig;
}) {
  return selectWorkflow({
    config: input.config ?? {},
    catalog,
    autonomyLevel: input.autonomyLevel,
    executionStyle: input.executionStyle,
    ...(input.taskType !== undefined ? { taskType: input.taskType } : {}),
    ...(input.paths !== undefined ? { paths: input.paths } : {}),
    ...(input.explicitWorkflow !== undefined ? { explicitWorkflow: input.explicitWorkflow } : {}),
  });
}

describe('selectWorkflow', () => {
  it('prefers an explicit workflow over everything else', () => {
    const result = select({
      autonomyLevel: 3,
      executionStyle: 'fast',
      explicitWorkflow: 'human-gated',
      paths: ['prisma/migrations/001.sql'],
      config: { workflows: { byPath: { 'prisma/migrations/**': 'migration' } } },
    });
    expect(result.workflowId).toBe('human-gated');
    expect(result.reason).toContain('Explicitly requested');
  });

  it('falls back to standard-feature when the explicit workflow is unknown', () => {
    const result = select({ autonomyLevel: 3, executionStyle: 'fast', explicitWorkflow: 'nope' });
    expect(result.workflowId).toBe('standard-feature');
    expect(result.reason).toContain('not in the catalog');
  });

  it('matches config.workflows.byPath before the mapping table', () => {
    const result = select({
      autonomyLevel: 3,
      executionStyle: 'fast',
      paths: ['src/billing/invoice.ts'],
      config: { workflows: { byPath: { 'src/billing/**': 'security-review' } } },
    });
    expect(result.workflowId).toBe('security-review');
    expect(result.reason).toContain('byPath');
  });

  describe('level/style mapping table', () => {
    const styles: ExecutionStyle[] = [
      'fast',
      'team_default',
      'careful',
      'structured',
      'explore',
      'custom',
    ];

    it('L0 → review-only for every style', () => {
      for (const style of styles) {
        expect(select({ autonomyLevel: 0, executionStyle: style }).workflowId).toBe('review-only');
      }
    });

    it('L0 + security task → security-review', () => {
      expect(
        select({ autonomyLevel: 0, executionStyle: 'fast', taskType: 'security' }).workflowId,
      ).toBe('security-review');
    });

    it('L1 → assist for every style', () => {
      for (const style of styles) {
        expect(select({ autonomyLevel: 1, executionStyle: style }).workflowId).toBe('assist');
      }
    });

    it('L2 → propose-patch (refactor → safe-refactor)', () => {
      for (const style of styles) {
        expect(select({ autonomyLevel: 2, executionStyle: style }).workflowId).toBe('propose-patch');
      }
      expect(
        select({ autonomyLevel: 2, executionStyle: 'fast', taskType: 'refactor' }).workflowId,
      ).toBe('safe-refactor');
    });

    it('L3 maps each style per the table', () => {
      expect(select({ autonomyLevel: 3, executionStyle: 'fast' }).workflowId).toBe('fast-fix');
      expect(select({ autonomyLevel: 3, executionStyle: 'structured' }).workflowId).toBe(
        'structured-feature',
      );
      expect(select({ autonomyLevel: 3, executionStyle: 'explore' }).workflowId).toBe(
        'explore-alternatives',
      );
      expect(select({ autonomyLevel: 3, executionStyle: 'careful' }).workflowId).toBe(
        'standard-feature',
      );
      expect(select({ autonomyLevel: 3, executionStyle: 'custom' }).workflowId).toBe(
        'standard-feature',
      );
    });

    it('L3 team_default resolves byTaskType, then config default, then standard-feature', () => {
      expect(
        select({
          autonomyLevel: 3,
          executionStyle: 'team_default',
          taskType: 'bugfix',
          config: { workflows: { byTaskType: { bugfix: 'fast-fix' }, default: 'safe-refactor' } },
        }).workflowId,
      ).toBe('fast-fix');
      expect(
        select({
          autonomyLevel: 3,
          executionStyle: 'team_default',
          config: { workflows: { default: 'safe-refactor' } },
        }).workflowId,
      ).toBe('safe-refactor');
      expect(select({ autonomyLevel: 3, executionStyle: 'team_default' }).workflowId).toBe(
        'standard-feature',
      );
    });

    it('L4 maps explore/careful specially and everything else to structured-feature', () => {
      expect(select({ autonomyLevel: 4, executionStyle: 'explore' }).workflowId).toBe(
        'explore-alternatives',
      );
      expect(select({ autonomyLevel: 4, executionStyle: 'careful' }).workflowId).toBe('human-gated');
      for (const style of ['fast', 'team_default', 'structured', 'custom'] as ExecutionStyle[]) {
        expect(select({ autonomyLevel: 4, executionStyle: style }).workflowId).toBe(
          'structured-feature',
        );
      }
    });

    it('L4 routes sensitive task types to their specialized workflow', () => {
      // A security task at the highest autonomy must NOT fall through to the
      // generic structured-feature — it gets the dedicated review workflow.
      expect(
        select({ autonomyLevel: 4, executionStyle: 'fast', taskType: 'security' }).workflowId,
      ).toBe('security-review');
      expect(
        select({ autonomyLevel: 4, executionStyle: 'structured', taskType: 'migration' }).workflowId,
      ).toBe('migration');
      // An explicit explore/careful style still wins over taskType.
      expect(
        select({ autonomyLevel: 4, executionStyle: 'careful', taskType: 'security' }).workflowId,
      ).toBe('human-gated');
    });
  });

  it('falls back to standard-feature when a config mapping names a missing workflow', () => {
    const result = select({
      autonomyLevel: 3,
      executionStyle: 'team_default',
      config: { workflows: { default: 'does-not-exist' } },
    });
    expect(result.workflowId).toBe('standard-feature');
    expect(result.reason).toContain('does-not-exist');
  });

  it('returns the catalog definition for the selected id', () => {
    const result = select({ autonomyLevel: 3, executionStyle: 'fast' });
    expect(result.definition.id).toBe('fast-fix');
    expect(result.definition.phases.length).toBeGreaterThan(0);
  });
});
