import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRUST_RULES,
  detectedSkillSchema,
  instructionSourceSchema,
  resolveDefaultTrust,
  type DetectedSkill,
  type InstructionSource,
} from './instructions';

const claudeSource: InstructionSource = {
  id: 'claude-project',
  scope: 'project',
  format: 'claude_md',
  kind: 'instruction',
  path: './CLAUDE.md',
  title: 'Project instructions',
  contentHash: 'a'.repeat(64),
  trustLevel: 'trusted',
  enabled: true,
  importedAs: 'instruction',
  metadata: {},
};

describe('instructionSourceSchema', () => {
  it('accepts a project CLAUDE.md source', () => {
    expect(instructionSourceSchema.safeParse(claudeSource).success).toBe(true);
  });

  it('accepts a null title and arbitrary metadata', () => {
    const result = instructionSourceSchema.safeParse({
      ...claudeSource,
      title: null,
      metadata: { sizeBytes: 1024, nested: { ok: true } },
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown scope, format, kind or trust level', () => {
    expect(
      instructionSourceSchema.safeParse({ ...claudeSource, scope: 'team' }).success,
    ).toBe(false);
    expect(
      instructionSourceSchema.safeParse({ ...claudeSource, format: 'markdown' }).success,
    ).toBe(false);
    expect(
      instructionSourceSchema.safeParse({ ...claudeSource, kind: 'note' }).success,
    ).toBe(false);
    expect(
      instructionSourceSchema.safeParse({ ...claudeSource, trustLevel: 'verified' }).success,
    ).toBe(false);
    expect(
      instructionSourceSchema.safeParse({ ...claudeSource, importedAs: 'note' }).success,
    ).toBe(false);
  });

  it('rejects missing required fields', () => {
    expect(instructionSourceSchema.safeParse({ ...claudeSource, id: '' }).success).toBe(false);
    expect(
      instructionSourceSchema.safeParse({ ...claudeSource, contentHash: '' }).success,
    ).toBe(false);
  });
});

describe('detectedSkillSchema', () => {
  const skillSource: InstructionSource = {
    ...claudeSource,
    id: 'skill-testing',
    format: 'skill_md',
    kind: 'skill',
    path: './.claude/skills/testing/SKILL.md',
    trustLevel: 'review_required',
    enabled: false,
    importedAs: 'skill',
  };

  const skill: DetectedSkill = {
    id: 'skill-testing',
    name: 'testing',
    path: './.claude/skills/testing/SKILL.md',
    scope: 'project',
    description: 'Runs the project test workflow',
    triggers: ['test', 'vitest'],
    dependencies: [],
    toolsRequired: ['run_command'],
    trustLevel: 'review_required',
    enabled: false,
    source: skillSource,
  };

  it('accepts a detected project skill with its embedded source', () => {
    expect(detectedSkillSchema.safeParse(skill).success).toBe(true);
  });

  it('accepts an unparseable skill (null description, empty arrays)', () => {
    const result = detectedSkillSchema.safeParse({
      ...skill,
      description: null,
      triggers: [],
      toolsRequired: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a skill with an invalid scope or a malformed source', () => {
    expect(detectedSkillSchema.safeParse({ ...skill, scope: 'enterprise' }).success).toBe(false);
    expect(
      detectedSkillSchema.safeParse({ ...skill, source: { id: 'broken' } }).success,
    ).toBe(false);
  });
});

describe('DEFAULT_TRUST_RULES', () => {
  function ruleFor(format: string, scope: string) {
    return DEFAULT_TRUST_RULES.find((r) => r.format === format && r.scope === scope);
  }

  it('trusts project instruction files (ISD spec §3)', () => {
    for (const format of ['claude_md', 'agents_md', 'cursor_rules', 'copilot_instructions']) {
      expect(ruleFor(format, 'project')).toMatchObject({
        trustLevel: 'trusted',
        kind: 'instruction',
      });
    }
  });

  it('classifies project docs and ADRs as trusted context', () => {
    expect(ruleFor('docs', 'project')).toMatchObject({ trustLevel: 'trusted', kind: 'context' });
    expect(ruleFor('adr', 'project')).toMatchObject({ trustLevel: 'trusted', kind: 'context' });
  });

  it('trusts the user-global CLAUDE.md for local context', () => {
    expect(ruleFor('claude_md', 'user_global')).toMatchObject({
      trustLevel: 'trusted',
      kind: 'instruction',
    });
  });

  it('marks SKILL.md review_required in both scopes (never auto-enabled)', () => {
    expect(ruleFor('skill_md', 'project')).toMatchObject({
      trustLevel: 'review_required',
      kind: 'skill',
    });
    expect(ruleFor('skill_md', 'user_global')).toMatchObject({
      trustLevel: 'review_required',
      kind: 'skill',
    });
  });

  it('never marks anything untrusted by default but never trusts unknown skills', () => {
    for (const rule of DEFAULT_TRUST_RULES) {
      if (rule.format === 'skill_md') {
        expect(rule.trustLevel).not.toBe('trusted');
      }
    }
  });
});

describe('resolveDefaultTrust', () => {
  it('returns the table entry when one exists', () => {
    expect(resolveDefaultTrust('claude_md', 'project')).toEqual({
      trustLevel: 'trusted',
      kind: 'instruction',
    });
  });

  it('falls back conservatively for unlisted combinations', () => {
    expect(resolveDefaultTrust('agents_md', 'user_global')).toEqual({
      trustLevel: 'review_required',
      kind: 'instruction',
    });
    expect(resolveDefaultTrust('skill_md', 'enterprise')).toEqual({
      trustLevel: 'review_required',
      kind: 'skill',
    });
  });
});
