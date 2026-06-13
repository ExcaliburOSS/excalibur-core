import { describe, expect, it } from 'vitest';
import { ExcaliburError } from '@excalibur/shared';
import {
  COMMENT_TEMPLATE_NAMES,
  COMMENT_TEMPLATES,
  renderCommentTemplate,
  TemplateRenderError,
  type CommentTemplateName,
} from './templates';

const FULL_VARS: Record<CommentTemplateName, Record<string, string>> = {
  run_started: {
    title: 'Fix duplicate escrow release',
    repository: 'quickcontract-api',
    workflow: 'standard-feature',
    autonomyLevelLabel: 'Level 3 — Implement in Branch',
    executionStyle: 'team_default',
    runUrl: 'https://app.example.com/runs/run_20260612_101500',
  },
  plan_generated: {
    planSummary: '1. Add idempotency guard\n2. Cover with tests',
    url: 'https://app.example.com/interactions/int_20260612_101500',
  },
  patch_suggested: {
    filesAffected: '- src/escrow/escrow.service.ts\n- src/escrow/escrow.service.spec.ts',
    summary: 'Adds a release-id guard so a release is processed once.',
    patchUrl: 'https://app.example.com/patches/patch_20260612_101500',
  },
  pr_opened: {
    pullRequestUrl: 'https://github.com/acme/quickcontract-api/pull/42',
    runUrl: 'https://app.example.com/runs/run_20260612_101500',
    summary: 'Implements idempotent escrow release.',
  },
  run_failed: {
    reason: 'Tests failed in the command_group phase.',
    runUrl: 'https://app.example.com/runs/run_20260612_101500',
  },
  need_repository: {},
  identity_not_verified: {},
};

describe('COMMENT_TEMPLATES', () => {
  it('contains exactly the seven pinned template names', () => {
    expect([...COMMENT_TEMPLATE_NAMES]).toEqual([
      'run_started',
      'plan_generated',
      'patch_suggested',
      'pr_opened',
      'run_failed',
      'need_repository',
      'identity_not_verified',
    ]);
    expect(Object.keys(COMMENT_TEMPLATES).sort()).toEqual([...COMMENT_TEMPLATE_NAMES].sort());
  });

  it('keeps the spec template bodies verbatim', () => {
    expect(COMMENT_TEMPLATES.run_started).toBe(
      'Excalibur started an agentic run.\n\nTask: {{title}}\nRepository: {{repository}}\n' +
        'Workflow: {{workflow}}\nAutonomy: {{autonomyLevelLabel}}\nExecution: {{executionStyle}}\n\n' +
        'Run: {{runUrl}}',
    );
    expect(COMMENT_TEMPLATES.need_repository).toBe(
      'Excalibur needs a target repository before it can continue.\n\nPlease use:\n' +
        '@excalibur implement --repo <repository-name>',
    );
    expect(COMMENT_TEMPLATES.identity_not_verified).toBe(
      'Excalibur could not verify your identity. Please connect your Excalibur account ' +
        'before running this command.',
    );
  });
});

describe('renderCommentTemplate', () => {
  it.each(COMMENT_TEMPLATE_NAMES.map((name) => [name]))(
    'renders %s with all variables substituted',
    (name) => {
      const rendered = renderCommentTemplate(name, FULL_VARS[name]);
      expect(rendered).not.toMatch(/\{\{/);
      expect(rendered).not.toMatch(/\}\}/);
      for (const value of Object.values(FULL_VARS[name])) {
        expect(rendered).toContain(value);
      }
    },
  );

  it('renders run_started exactly', () => {
    expect(renderCommentTemplate('run_started', FULL_VARS.run_started)).toBe(
      [
        'Excalibur started an agentic run.',
        '',
        'Task: Fix duplicate escrow release',
        'Repository: quickcontract-api',
        'Workflow: standard-feature',
        'Autonomy: Level 3 — Implement in Branch',
        'Execution: team_default',
        '',
        'Run: https://app.example.com/runs/run_20260612_101500',
      ].join('\n'),
    );
  });

  it('renders templates without variables as-is', () => {
    expect(renderCommentTemplate('need_repository', {})).toBe(COMMENT_TEMPLATES.need_repository);
    expect(renderCommentTemplate('identity_not_verified', {})).toBe(
      COMMENT_TEMPLATES.identity_not_verified,
    );
  });

  it('substitutes multiline variable values', () => {
    const rendered = renderCommentTemplate('plan_generated', FULL_VARS.plan_generated);
    expect(rendered).toContain('1. Add idempotency guard\n2. Cover with tests');
  });

  it('accepts empty strings as provided values', () => {
    const rendered = renderCommentTemplate('run_failed', { reason: '', runUrl: 'https://x' });
    expect(rendered).toContain('Reason:\n\n');
  });

  it('ignores extra variables', () => {
    expect(() =>
      renderCommentTemplate('run_failed', {
        ...FULL_VARS.run_failed,
        unused: 'value',
      }),
    ).not.toThrow();
  });

  it.each(
    COMMENT_TEMPLATE_NAMES.filter((name) => Object.keys(FULL_VARS[name]).length > 0).map(
      (name) => [name],
    ),
  )('throws template_missing_variable when %s is rendered without variables', (name) => {
    let caught: unknown;
    try {
      renderCommentTemplate(name, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TemplateRenderError);
    expect(caught).toBeInstanceOf(ExcaliburError);
    expect((caught as TemplateRenderError).code).toBe('template_missing_variable');
    expect((caught as TemplateRenderError).details).toMatchObject({
      template: name,
      missing: Object.keys(FULL_VARS[name]),
    });
  });

  it('reports only the missing variables when some are provided', () => {
    let caught: unknown;
    try {
      renderCommentTemplate('run_started', {
        title: 'T',
        repository: 'R',
        workflow: 'W',
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as TemplateRenderError).details).toMatchObject({
      missing: ['autonomyLevelLabel', 'executionStyle', 'runUrl'],
    });
    expect((caught as TemplateRenderError).message).toContain('autonomyLevelLabel');
  });

  it('throws template_not_found for an unknown template name', () => {
    let caught: unknown;
    try {
      renderCommentTemplate('nope' as CommentTemplateName, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TemplateRenderError);
    expect((caught as TemplateRenderError).code).toBe('template_not_found');
  });
});
