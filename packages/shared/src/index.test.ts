import { describe, expect, it } from 'vitest';
import * as shared from './index';

/** Guards the pinned public API surface (Build Contract §4.1). */
describe('@excalibur/shared index', () => {
  it('re-exports the frozen keystone modules', () => {
    // autonomy.ts
    expect(shared.AUTONOMY_LEVELS.FULL_AGENTIC).toBe(4);
    expect(shared.autonomyLevelSchema).toBeDefined();
    expect(shared.AUTONOMY_LEVEL_LABELS[0]).toContain('Review');
    expect(shared.AUTONOMY_LEVEL_DESCRIPTIONS[2]).toBeTruthy();
    expect(shared.isAutonomyLevel(3)).toBe(true);
    expect(shared.isAutonomyLevel(5)).toBe(false);

    // enums.ts
    for (const schema of [
      shared.executionStyleSchema,
      shared.outputTypeSchema,
      shared.runStatusSchema,
      shared.phaseStatusSchema,
      shared.agentRoleSchema,
      shared.workflowModeSchema,
      shared.phaseTypeSchema,
      shared.testStatusSchema,
      shared.riskLevelSchema,
      shared.policyDecisionSchema,
    ]) {
      expect(schema).toBeDefined();
    }

    // events.ts
    expect(shared.excaliburEventTypeSchema).toBeDefined();
    expect(shared.excaliburEventSchema).toBeDefined();
    expect(typeof shared.createEvent).toBe('function');
    expect(typeof shared.serializeEventLine).toBe('function');
    expect(typeof shared.parseEventsJsonl).toBe('function');

    // discovery.ts
    expect(shared.discoveryInputTypeSchema).toBeDefined();
    expect(shared.discoveryRecordSchema).toBeDefined();
    expect(shared.AGENT_READINESS_TO_AUTONOMY).toBeDefined();
    expect(shared.DISCOVERY_ARTIFACT_FILES).toContain('discovery.json');
    expect(typeof shared.scoreDiscoveryTranscript).toBe('function');
    expect(typeof shared.recommendFromScores).toBe('function');
  });

  it('exports the error hierarchy', () => {
    expect(new shared.ConfigValidationError('x')).toBeInstanceOf(shared.ExcaliburError);
    expect(new shared.WorkflowValidationError('x')).toBeInstanceOf(shared.ExcaliburError);
    expect(new shared.PermissionDeniedError('x')).toBeInstanceOf(shared.ExcaliburError);
    expect(new shared.ProviderError('x')).toBeInstanceOf(shared.ExcaliburError);
    expect(new shared.RunNotFoundError('x')).toBeInstanceOf(shared.ExcaliburError);
    expect(new shared.CommandParseError('x')).toBeInstanceOf(shared.ExcaliburError);
  });

  it('exports artifacts, config, ids and ISD contracts', () => {
    expect(shared.runRecordSchema).toBeDefined();
    expect(shared.RUN_ARTIFACT_FILES).toHaveLength(13);
    expect(shared.excaliburConfigSchema).toBeDefined();
    expect(shared.DEFAULT_BLOCKED_PATHS.length).toBeGreaterThan(0);
    expect(shared.DEFAULT_ALLOWED_COMMANDS.length).toBeGreaterThan(0);
    expect(shared.DEFAULT_CONFIG.safety?.preset).toBe('standard-safe');
    expect(typeof shared.generateRunId).toBe('function');
    expect(typeof shared.generateId).toBe('function');
    expect(shared.instructionSourceSchema).toBeDefined();
    expect(shared.detectedSkillSchema).toBeDefined();
    expect(Array.isArray(shared.DEFAULT_TRUST_RULES)).toBe(true);
  });
});
