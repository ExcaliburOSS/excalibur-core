import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@excalibur/shared';
import { fakeAnalysis } from '../test-utils';
import {
  classifyTaskIntent,
  COMMAND_DEFAULTS,
  permissionEngineForConfig,
  SAFETY_PRESETS,
} from './onboarding';

describe('COMMAND_DEFAULTS', () => {
  it('mirrors the onboarding §6 command table', () => {
    expect(COMMAND_DEFAULTS['ask']).toMatchObject({
      entity: 'interaction',
      autonomyLevel: 1,
      workflow: 'ask-repo',
    });
    expect(COMMAND_DEFAULTS['review']).toMatchObject({
      entity: 'interaction',
      autonomyLevel: 0,
      workflow: 'review-only',
    });
    expect(COMMAND_DEFAULTS['patch']).toMatchObject({
      entity: 'patch',
      autonomyLevel: 2,
      workflow: 'propose-patch',
    });
    expect(COMMAND_DEFAULTS['run']).toMatchObject({ entity: 'run', autonomyLevel: 3 });
    expect(COMMAND_DEFAULTS['careful']).toMatchObject({
      entity: 'run',
      autonomyLevel: 4,
      workflow: 'structured-feature',
    });
    expect(COMMAND_DEFAULTS['explore']).toMatchObject({ workflow: 'explore-alternatives' });
    expect(COMMAND_DEFAULTS['discovery']).toMatchObject({
      entity: 'discovery',
      autonomyLevel: 0,
      workflow: 'discovery',
    });
  });
});

describe('SAFETY_PRESETS', () => {
  it('ships standard-safe with the onboarding §5 permission set', () => {
    const preset = SAFETY_PRESETS['standard-safe'];
    expect(preset).toBeDefined();
    expect(preset?.permissions.tools?.['read_file']).toBe(true);
    expect(preset?.permissions.tools?.['write_file']).toBe('ask');
    expect(preset?.permissions.tools?.['apply_patch']).toBe('ask');
    expect(preset?.permissions.tools?.['push']).toBe(false);
    expect(preset?.permissions.tools?.['network']).toBe(false);
    expect(preset?.permissions.blockedPaths).toContain('**/*.p12');
    expect(preset?.permissions.blockedPaths).toContain('**/*.pfx');
    expect(preset?.permissions.blockedPaths).toContain('.git/**');
    expect(preset?.policyPreset.id).toBe('standard-safe');
  });

  it('feeds the PermissionEngine: blocked paths deny, writes ask, push denied', () => {
    const engine = permissionEngineForConfig(DEFAULT_CONFIG);
    expect(engine.checkPath('.env', 'read').allowed).toBe(false);
    expect(engine.checkPath('.git/config', 'read').allowed).toBe(false);
    expect(engine.checkPath('certs/site.p12', 'read').allowed).toBe(false);
    expect(engine.checkPath('src/app.ts', 'read').allowed).toBe(true);
    const write = engine.checkPath('src/app.ts', 'write');
    expect(write.allowed).toBe(true);
    expect(write.requiresConfirmation).toBe(true);
    expect(engine.checkTool('push').allowed).toBe(false);
    expect(engine.checkTool('network').allowed).toBe(false);
  });

  it('adds detected commands to the allowlist (ask, not unknown)', () => {
    const engine = permissionEngineForConfig({
      ...DEFAULT_CONFIG,
      commands: { test: 'pnpm vitest run' },
    });
    const decision = engine.checkCommand('pnpm vitest run');
    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirmation).toBe(true);
    expect(decision.reason).toContain('allowlisted');
  });
});

describe('classifyTaskIntent', () => {
  const analysis = fakeAnalysis();

  it('classifies a narrow bugfix as fast-fix at level 3', () => {
    const intent = classifyTaskIntent('Fix typo in the user greeting message', analysis, {});
    expect(intent.taskType).toBe('bugfix');
    expect(intent.recommendedWorkflow).toBe('fast-fix');
    expect(intent.recommendedAutonomy).toBe(3);
    expect(intent.sensitive).toBe(false);
    expect(intent.recommendDiscoveryFirst).toBe(false);
  });

  it('classifies normal feature work as standard-feature at level 3', () => {
    const intent = classifyTaskIntent(
      'Implement renewal reminder notifications for expiring documents',
      analysis,
      {},
    );
    expect(intent.taskType).toBe('feature');
    expect(intent.recommendedWorkflow).toBe('standard-feature');
    expect(intent.recommendedAutonomy).toBe(3);
  });

  it('recommends Discovery first for short/vague tasks', () => {
    const intent = classifyTaskIntent('reminders', analysis, {});
    expect(intent.taskType).toBe('ambiguous');
    expect(intent.recommendDiscoveryFirst).toBe(true);
    expect(intent.recommendedWorkflow).toBe('discovery');
    expect(intent.recommendedAutonomy).toBe(0);
  });

  it('recommends Discovery for tasks without a recognizable action verb', () => {
    const intent = classifyTaskIntent('something about the dashboard maybe', analysis, {});
    expect(intent.taskType).toBe('ambiguous');
    expect(intent.recommendDiscoveryFirst).toBe(true);
  });

  it('classifies alternative-seeking tasks as explore-alternatives', () => {
    const intent = classifyTaskIntent(
      'Explore approaches for contract versioning',
      analysis,
      {},
    );
    expect(intent.taskType).toBe('alternatives');
    expect(intent.recommendedWorkflow).toBe('explore-alternatives');
    expect(intent.recommendedAutonomy).toBe(3);
  });

  it('recommends careful security-review for security tasks', () => {
    const intent = classifyTaskIntent('Harden security of the token validation flow', analysis, {});
    expect(intent.taskType).toBe('security');
    expect(intent.sensitive).toBe(true);
    expect(intent.recommendedWorkflow).toBe('security-review');
    expect(intent.recommendedAutonomy).toBe(4);
  });

  it('recommends the migration workflow for migration tasks', () => {
    const intent = classifyTaskIntent(
      'Migrate the database schema to add an invoices table',
      analysis,
      {},
    );
    expect(intent.taskType).toBe('migration');
    expect(intent.sensitive).toBe(true);
    expect(intent.sensitiveAreas).toContain('migrations');
    expect(intent.recommendedWorkflow).toBe('migration');
    expect(intent.recommendedAutonomy).toBe(4);
  });

  it('recommends careful structured work for sensitive keyword areas', () => {
    const intent = classifyTaskIntent(
      'Fix the duplicated escrow release when the payment webhook retries',
      analysis,
      {},
    );
    expect(intent.taskType).toBe('bugfix');
    expect(intent.sensitive).toBe(true);
    expect(intent.sensitiveAreas).toContain('payments');
    expect(intent.recommendedWorkflow).toBe('structured-feature');
    expect(intent.recommendedAutonomy).toBe(4);
  });

  it('flags config autonomy.paths hits as sensitive', () => {
    const intent = classifyTaskIntent(
      'Fix the rounding helper in src/ledger/totals.ts so sums match',
      analysis,
      { autonomy: { paths: { 'src/ledger/**': 0 } } },
    );
    expect(intent.sensitive).toBe(true);
    expect(intent.sensitiveAreas).toContain('src/ledger/**');
    expect(intent.recommendedAutonomy).toBe(4);
  });

  it('classifies refactors as safe-refactor', () => {
    const intent = classifyTaskIntent(
      'Refactor the notification module without changing behavior',
      analysis,
      {},
    );
    expect(intent.taskType).toBe('refactor');
    expect(intent.recommendedWorkflow).toBe('safe-refactor');
  });

  it('classifies docs-only work as fast-fix', () => {
    const intent = classifyTaskIntent('Update the README setup documentation', analysis, {});
    expect(intent.taskType).toBe('docs');
    expect(intent.recommendedWorkflow).toBe('fast-fix');
  });

  it('mentions weak tests in the reason when no test command is detected', () => {
    const noTests = fakeAnalysis({ commands: {} });
    const intent = classifyTaskIntent(
      'Implement renewal reminder notifications for expiring documents',
      noTests,
      {},
    );
    expect(intent.reason).toContain('No test command');
  });
});
