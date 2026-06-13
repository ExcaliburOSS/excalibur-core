import { describe, expect, it } from 'vitest';
import { WorkflowValidationError } from '@excalibur/shared';
import { parseDeclarativeMarkdown } from './markdown';

const ARTIFACT_MARKDOWN = `# {{title}}

## Problem
{{problem}}

## Acceptance criteria
{{acceptance_criteria}}

## Out of scope
{{out_of_scope}}
`;

const PROMPT_MARKDOWN = `Synthesize the discovery transcript below into a refined ticket.

{{transcript}}
`;

describe('parseDeclarativeMarkdown — directory hints', () => {
  it('parses an artifact template from an artifacts/ directory', () => {
    const parsed = parseDeclarativeMarkdown(
      '.excalibur/artifacts/refined-ticket.md',
      ARTIFACT_MARKDOWN,
    );
    expect(parsed.type).toBe('artifact_template');
    expect(parsed.id).toBe('refined-ticket');
    expect(parsed.name).toBe('Refined Ticket');
    if (parsed.type === 'artifact_template') {
      expect(parsed.variables).toEqual([
        'title',
        'problem',
        'acceptance_criteria',
        'out_of_scope',
      ]);
    }
  });

  it('parses a prompt template from a prompts/ directory', () => {
    const parsed = parseDeclarativeMarkdown(
      '.excalibur/prompts/discovery-synthesis.md',
      PROMPT_MARKDOWN,
    );
    expect(parsed.type).toBe('prompt_template');
    expect(parsed.id).toBe('discovery-synthesis');
    expect(parsed.name).toBe('Discovery Synthesis');
    expect(parsed.template).toContain('{{transcript}}');
  });

  it('uses the directory closest to the file when several hints appear', () => {
    const parsed = parseDeclarativeMarkdown(
      'extensions/discovery-pack/artifacts/prompts/special.md',
      PROMPT_MARKDOWN,
    );
    expect(parsed.type).toBe('prompt_template');
  });

  it('handles Windows-style path separators', () => {
    const parsed = parseDeclarativeMarkdown(
      'C:\\repo\\.excalibur\\artifacts\\mvp-scope.md',
      '## Scope\n{{scope}}\n',
    );
    expect(parsed.type).toBe('artifact_template');
    expect(parsed.id).toBe('mvp-scope');
  });

  it('strips .markdown extensions when deriving the id', () => {
    const parsed = parseDeclarativeMarkdown(
      'prompts/code-review.markdown',
      'Review the diff.\n{{diff}}',
    );
    expect(parsed.id).toBe('code-review');
    expect(parsed.name).toBe('Code Review');
  });
});

describe('parseDeclarativeMarkdown — front matter', () => {
  it('front-matter type overrides the directory hint', () => {
    const content = `---
type: artifact_template
---
# {{title}}
`;
    const parsed = parseDeclarativeMarkdown('.excalibur/prompts/odd-one.md', content);
    expect(parsed.type).toBe('artifact_template');
    if (parsed.type === 'artifact_template') {
      expect(parsed.variables).toEqual(['title']);
    }
  });

  it('front-matter id, name and description are respected', () => {
    const content = `---
id: custom-id
name: Custom Name
description: A custom prompt.
---
Body with {{value}}.
`;
    const parsed = parseDeclarativeMarkdown('.excalibur/prompts/file-name.md', content);
    expect(parsed.id).toBe('custom-id');
    expect(parsed.name).toBe('Custom Name');
    expect(parsed.description).toBe('A custom prompt.');
    expect(parsed.template).toBe('Body with {{value}}.');
  });

  it('front-matter declared variables merge after extracted ones', () => {
    const content = `---
type: artifact_template
variables:
  - reviewer
---
# {{title}}
`;
    const parsed = parseDeclarativeMarkdown('docs/readiness-assessment.md', content);
    if (parsed.type === 'artifact_template') {
      expect(parsed.variables).toEqual(['title', 'reviewer']);
    } else {
      expect.unreachable('expected an artifact template');
    }
  });

  it('determines the type from front matter even without a directory hint', () => {
    const content = `---
type: prompt_template
---
Explain {{topic}} simply.
`;
    const parsed = parseDeclarativeMarkdown('notes/explainer.md', content);
    expect(parsed.type).toBe('prompt_template');
  });

  it('rejects front-matter types that are not Markdown declarative types', () => {
    const content = `---
type: workflow
---
Body.
`;
    try {
      parseDeclarativeMarkdown('.excalibur/prompts/not-a-workflow.md', content);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowValidationError);
      const message = (error as WorkflowValidationError).message;
      expect(message).toContain('not-a-workflow.md');
      expect(message).toContain('prompt_template or artifact_template');
    }
  });

  it('rejects invalid front-matter YAML with the file path in the message', () => {
    const content = `---
id: [broken
---
Body.
`;
    expect(() => parseDeclarativeMarkdown('.excalibur/prompts/broken.md', content)).toThrowError(
      /Invalid front matter in .*broken\.md/,
    );
  });

  it('tolerates empty front matter', () => {
    const content = `---
---
Just a body with {{value}}.
`;
    const parsed = parseDeclarativeMarkdown('.excalibur/prompts/plain.md', content);
    expect(parsed.id).toBe('plain');
    expect(parsed.template).toBe('Just a body with {{value}}.');
  });
});

describe('parseDeclarativeMarkdown — bad fixtures give readable errors', () => {
  it('rejects files with no type hint at all', () => {
    try {
      parseDeclarativeMarkdown('notes/random.md', 'Some content.');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowValidationError);
      expect((error as WorkflowValidationError).code).toBe('workflow_validation');
      const message = (error as WorkflowValidationError).message;
      expect(message).toContain('notes/random.md');
      expect(message).toContain('prompts/');
      expect(message).toContain('artifacts/');
    }
  });

  it('rejects an empty body below the front matter', () => {
    const content = `---
type: prompt_template
---
`;
    try {
      parseDeclarativeMarkdown('.excalibur/prompts/empty.md', content);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowValidationError);
      const message = (error as WorkflowValidationError).message;
      expect(message).toContain('empty.md');
      expect(message).toContain('template');
    }
  });

  it('rejects a non-string front-matter id, pointing at the path', () => {
    const content = `---
id: 42
---
Body.
`;
    try {
      parseDeclarativeMarkdown('.excalibur/prompts/numeric-id.md', content);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowValidationError);
      expect((error as WorkflowValidationError).message).toContain('id');
    }
  });
});
