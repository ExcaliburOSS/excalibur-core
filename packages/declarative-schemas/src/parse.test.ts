import { describe, expect, it } from 'vitest';
import { WorkflowValidationError } from '@excalibur/shared';
import { DEFAULT_METHODOLOGIES, DEFAULT_WORKFLOWS } from '@excalibur/workflow-schema';
import { parseDeclarativeYaml } from './parse';

/**
 * YAML fixtures matching the shapes pinned in extensions-spec.md §4,
 * one per declarative type.
 */

const QUESTION_PACK_YAML = `
id: agent-readiness
type: question_pack
name: Agent Readiness
questions:
  - id: problem
    text: Is the goal clear enough for an agent?
  - id: acceptance
    text: Are acceptance criteria present?
`;

const PROMPT_TEMPLATE_YAML = `
id: discovery-synthesis
type: prompt_template
name: Discovery Synthesis
template: |
  Synthesize the discovery transcript into a refined ticket.

  {{transcript}}
`;

const ARTIFACT_TEMPLATE_YAML = `
id: refined-ticket
type: artifact_template
name: Refined Ticket
template: |
  # {{title}}

  ## Problem
  {{problem}}

  ## Acceptance criteria
  {{acceptance_criteria}}
`;

const POLICY_PRESET_YAML = `
id: standard-safe
type: policy_preset
rules:
  - id: block-secrets
    when:
      filePathMatches:
        - ".env"
        - "**/*.pem"
      action: read
    decision: deny
  - id: ask-before-write
    when:
      action: write_file
    decision: require_approval
  - id: allow-tests
    when:
      command: pnpm test
    decision: allow
  - id: redact-prompts
    when:
      action: prompt
    decision: redact
`;

const MODEL_ROUTING_YAML = `
id: default-routing
type: model_routing
default: mock
byRole:
  planner: mock
  implementer: mock
byPath:
  "src/billing/**": careful-model
byWorkflow:
  security-review: careful-model
`;

const REPORT_TEMPLATE_YAML = `
id: daily-summary
type: report_template
name: Daily Summary
sections:
  - completed_runs
  - failed_runs
  - patches
  - pending_items
`;

const ROLE_DEFINITION_YAML = `
id: product-strategist
type: role_definition
name: Product Strategist
description: Challenges assumptions about user value and market fit during discovery.
`;

const COMMAND_MAPPING_YAML = `
id: work-item-commands
type: command_mapping
commands:
  - trigger: "@excalibur refine"
    action: work_item_refinement
    defaults:
      autonomyLevel: 0
  - trigger: "@excalibur run"
    action: run
    defaults:
      autonomyLevel: 3
      executionStyle: team_default
`;

describe('parseDeclarativeYaml — spec §4 examples', () => {
  it('parses a question_pack', () => {
    const parsed = parseDeclarativeYaml(QUESTION_PACK_YAML, 'question_pack');
    expect(parsed.id).toBe('agent-readiness');
    expect(parsed.questions.map((question) => question.id)).toEqual([
      'problem',
      'acceptance',
    ]);
  });

  it('parses a prompt_template', () => {
    const parsed = parseDeclarativeYaml(PROMPT_TEMPLATE_YAML, 'prompt_template');
    expect(parsed.name).toBe('Discovery Synthesis');
    expect(parsed.template).toContain('{{transcript}}');
  });

  it('parses an artifact_template and auto-extracts variables', () => {
    const parsed = parseDeclarativeYaml(ARTIFACT_TEMPLATE_YAML, 'artifact_template');
    expect(parsed.variables).toEqual(['title', 'problem', 'acceptance_criteria']);
  });

  it('parses a policy_preset', () => {
    const parsed = parseDeclarativeYaml(POLICY_PRESET_YAML, 'policy_preset');
    expect(parsed.rules.map((rule) => rule.decision)).toEqual([
      'deny',
      'require_approval',
      'allow',
      'redact',
    ]);
  });

  it('parses a model_routing', () => {
    const parsed = parseDeclarativeYaml(MODEL_ROUTING_YAML, 'model_routing');
    expect(parsed.byWorkflow?.['security-review']).toBe('careful-model');
  });

  it('parses a report_template', () => {
    const parsed = parseDeclarativeYaml(REPORT_TEMPLATE_YAML, 'report_template');
    expect(parsed.sections).toContain('pending_items');
  });

  it('parses a role_definition', () => {
    const parsed = parseDeclarativeYaml(ROLE_DEFINITION_YAML, 'role_definition');
    expect(parsed.name).toBe('Product Strategist');
  });

  it('parses a command_mapping', () => {
    const parsed = parseDeclarativeYaml(COMMAND_MAPPING_YAML, 'command_mapping');
    expect(parsed.commands[0]?.trigger).toBe('@excalibur refine');
    expect(parsed.commands[1]?.defaults?.autonomyLevel).toBe(3);
  });

  it('parses every built-in workflow YAML as a declarative workflow', () => {
    for (const entry of DEFAULT_WORKFLOWS) {
      const parsed = parseDeclarativeYaml(entry.yaml, 'workflow');
      expect(parsed.id).toBe(entry.id);
      expect(parsed.type).toBe('workflow');
    }
  });

  it('parses every built-in methodology YAML as a declarative methodology', () => {
    for (const entry of DEFAULT_METHODOLOGIES) {
      const parsed = parseDeclarativeYaml(entry.yaml, 'methodology');
      expect(parsed.id).toBe(entry.id);
      expect(parsed.type).toBe('methodology');
    }
  });
});

describe('parseDeclarativeYaml — type resolution', () => {
  it('uses the embedded type when no expectedType is given', () => {
    const parsed = parseDeclarativeYaml(ROLE_DEFINITION_YAML);
    expect(parsed.type).toBe('role_definition');
  });

  it('fills a missing type from the expectedType hint', () => {
    const parsed = parseDeclarativeYaml(
      'id: pack\nname: Pack\nquestions:\n  - id: q1\n    text: Why?\n',
      'question_pack',
    );
    expect(parsed.type).toBe('question_pack');
    expect(parsed.id).toBe('pack');
  });

  it('rejects a type that conflicts with expectedType', () => {
    expect(() => parseDeclarativeYaml(QUESTION_PACK_YAML, 'prompt_template')).toThrowError(
      WorkflowValidationError,
    );
    try {
      parseDeclarativeYaml(QUESTION_PACK_YAML, 'prompt_template');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowValidationError);
      const message = (error as WorkflowValidationError).message;
      expect(message).toContain('question_pack');
      expect(message).toContain('prompt_template');
    }
  });

  it('rejects a document without a type when no hint is given', () => {
    try {
      parseDeclarativeYaml('id: mystery\nname: Mystery\n');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowValidationError);
      const message = (error as WorkflowValidationError).message;
      expect(message).toContain('type');
      expect(message).toContain('question_pack');
    }
  });

  it('rejects an unknown type with a readable error', () => {
    expect(() => parseDeclarativeYaml('id: x\ntype: gizmo\n')).toThrowError(
      /unknown declarative type "gizmo"/,
    );
  });
});

describe('parseDeclarativeYaml — bad fixtures give readable errors', () => {
  it('throws WorkflowValidationError with code workflow_validation', () => {
    try {
      parseDeclarativeYaml('id: [broken\n', 'question_pack');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowValidationError);
      expect((error as WorkflowValidationError).code).toBe('workflow_validation');
    }
  });

  it('reports YAML syntax errors with the declarative type in the message', () => {
    expect(() => parseDeclarativeYaml('a: [1, 2\n', 'report_template')).toThrowError(
      /Invalid report_template definition YAML/,
    );
  });

  it('rejects non-mapping documents', () => {
    expect(() => parseDeclarativeYaml('- just\n- a\n- list\n', 'role_definition')).toThrowError(
      /expected a YAML mapping/,
    );
    expect(() => parseDeclarativeYaml('"scalar"', 'role_definition')).toThrowError(
      /expected a YAML mapping/,
    );
  });

  it('names the offending path and the definition id in schema errors', () => {
    const badPack = `
id: bad-pack
type: question_pack
name: Bad Pack
questions:
  - id: q1
`;
    try {
      parseDeclarativeYaml(badPack, 'question_pack');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowValidationError);
      const message = (error as WorkflowValidationError).message;
      expect(message).toContain('"bad-pack"');
      expect(message).toContain('questions[0].text');
    }
  });

  it('names the offending path through the union (no expectedType)', () => {
    const badPreset = `
id: loose
type: policy_preset
rules:
  - id: r1
    when: {}
    decision: maybe
`;
    try {
      parseDeclarativeYaml(badPreset);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowValidationError);
      const message = (error as WorkflowValidationError).message;
      expect(message).toContain('policy_preset definition "loose"');
      expect(message).toContain('rules[0].decision');
    }
  });

  it('exposes the issue list in error details', () => {
    try {
      parseDeclarativeYaml('id: ""\ntype: role_definition\n');
      expect.unreachable('should have thrown');
    } catch (error) {
      const details = (error as WorkflowValidationError).details;
      expect(Array.isArray(details?.issues)).toBe(true);
      expect((details?.issues as string[]).length).toBeGreaterThan(0);
    }
  });
});
