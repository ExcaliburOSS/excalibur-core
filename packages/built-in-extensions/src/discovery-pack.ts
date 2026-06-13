import type { DiscoveryInputType } from '@excalibur/shared';
import { DISCOVERY_QUESTION_PACKS } from '@excalibur/workflow-schema';
import {
  artifactTemplateSchema,
  type ArtifactTemplateDefinition,
  type PromptTemplateDefinition,
  type QuestionPackDefinition,
  type RoleDefinition,
} from '@excalibur/declarative-schemas';
import type { Contribution, ExtensionManifest } from '@excalibur/extension-runtime';
import { BUILT_IN_EXTENSION_VERSION, builtInContribution, type BuiltInExtensionPack } from './types';

const EXTENSION_ID = 'discovery-pack';

/**
 * Stable question-pack contribution id and display name per Discovery input
 * type. The questions themselves come from `DISCOVERY_QUESTION_PACKS` in
 * `@excalibur/workflow-schema` — this pack only wraps them.
 */
export const DISCOVERY_QUESTION_PACK_IDS: Record<DiscoveryInputType, string> = {
  idea: 'discovery-idea',
  work_item: 'discovery-work-item',
  customer_feedback: 'discovery-customer-feedback',
  technical_initiative: 'discovery-technical-initiative',
  incident: 'discovery-incident',
  agent_readiness: 'discovery-agent-readiness',
  mvp_scope: 'discovery-mvp-scope',
  other: 'discovery-other',
};

const QUESTION_PACK_NAMES: Record<DiscoveryInputType, string> = {
  idea: 'Discovery Questions — Product Idea',
  work_item: 'Discovery Questions — Existing Work Item',
  customer_feedback: 'Discovery Questions — Customer Feedback',
  technical_initiative: 'Discovery Questions — Technical Initiative',
  incident: 'Discovery Questions — Incident',
  agent_readiness: 'Discovery Questions — Agent Readiness',
  mvp_scope: 'Discovery Questions — MVP Scope',
  other: 'Discovery Questions — General',
};

const QUESTION_PACK_INPUT_TYPES = Object.keys(DISCOVERY_QUESTION_PACK_IDS) as DiscoveryInputType[];

const questionPackDefinitions: QuestionPackDefinition[] = QUESTION_PACK_INPUT_TYPES.map(
  (inputType) => ({
    id: DISCOVERY_QUESTION_PACK_IDS[inputType],
    type: 'question_pack',
    name: QUESTION_PACK_NAMES[inputType],
    description: `Guided Discovery questions for the "${inputType}" input type.`,
    questions: [...DISCOVERY_QUESTION_PACKS[inputType]],
  }),
);

/**
 * The six Discovery agent roles from the frozen `agentRoleSchema`
 * (`@excalibur/shared`), published as `role_definition` contributions so the
 * Discovery workflow's `role:` references resolve in the registry.
 */
export const DISCOVERY_ROLE_DEFINITIONS: ReadonlyArray<RoleDefinition> = [
  {
    id: 'product_strategist',
    type: 'role_definition',
    name: 'Product Strategist',
    description:
      'Frames the problem and the user during Discovery intake and guided questions. Keeps the conversation focused on the painful workflow, the evidence behind it and why it matters now.',
  },
  {
    id: 'customer_researcher',
    type: 'role_definition',
    name: 'Customer Researcher',
    description:
      'Synthesizes customer feedback into problems rather than feature requests: identifies the segment, counts the evidence and proposes the cheapest validation that could be run.',
  },
  {
    id: 'discovery_reviewer',
    type: 'role_definition',
    name: 'Discovery Reviewer',
    description:
      'Reviews the Discovery transcript and writes the synthesis. Challenges weak evidence, vague users and missing success criteria instead of papering over them.',
  },
  {
    id: 'ux_reviewer',
    type: 'role_definition',
    name: 'UX Reviewer',
    description:
      'Evaluates the user-experience implications of a proposal: workflow friction, discoverability and whether the smallest useful version is actually usable.',
  },
  {
    id: 'growth_reviewer',
    type: 'role_definition',
    name: 'Growth Reviewer',
    description:
      'Evaluates the buying, activation and retention impact of a proposal and flags work whose value hypothesis is unproven before implementation starts.',
  },
  {
    id: 'scope_guardian',
    type: 'role_definition',
    name: 'Scope Guardian',
    description:
      'Keeps scope minimal: defines what is explicitly out of scope, writes the readiness assessment and the recommendation, and is empowered to recommend not building at all.',
  },
];

/** `refined-ticket.md` — Discovery spec §3 refined ticket structure. */
export const REFINED_TICKET_TEMPLATE = `# {{title}}

## Problem
{{problem}}

## Expected behavior
{{expectedBehavior}}

## Acceptance criteria
{{acceptanceCriteria}}

## Scope
{{scope}}

## Out of scope
{{outOfScope}}

## Implementation notes
{{implementationNotes}}

## Test expectations
{{testExpectations}}

## Links
{{links}}
`;

/** `mvp-scope.md` — Discovery spec §3 MVP scope structure. */
export const MVP_SCOPE_TEMPLATE = `# MVP Scope — {{title}}

## In scope
{{inScope}}

## Out of scope
{{outOfScope}}

## First shippable version
{{firstShippableVersion}}

## Later iterations
{{laterIterations}}

## Overbuild risks
{{overbuildRisks}}
`;

/**
 * `readiness-assessment.md` — the Discovery spec §3 readiness card. Variable
 * names match the `DiscoveryRecord` fields from the frozen
 * `@excalibur/shared` discovery contract.
 */
export const READINESS_ASSESSMENT_TEMPLATE = `# Readiness Assessment — {{title}}

Problem clarity: {{problemClarity}}
User evidence: {{userEvidence}}
Scope clarity: {{scopeClarity}}
Technical risk: {{technicalRisk}}
Agent readiness: {{agentReadiness}}
Recommended autonomy level: {{recommendedAutonomyLevel}}
Recommended workflow: {{recommendedWorkflow}}
Recommendation: {{recommendation}}
Reason: {{reason}}
`;

const artifactTemplateDefinitions: ArtifactTemplateDefinition[] = [
  artifactTemplateSchema.parse({
    id: 'refined-ticket',
    type: 'artifact_template',
    name: 'Refined Ticket',
    description:
      'Implementation-ready ticket produced by Discovery: problem, expected behavior, acceptance criteria, scope and test expectations.',
    template: REFINED_TICKET_TEMPLATE,
  }),
  artifactTemplateSchema.parse({
    id: 'mvp-scope',
    type: 'artifact_template',
    name: 'MVP Scope',
    description:
      'Smallest useful version of a proposal: in/out of scope, first shippable version, later iterations and overbuild risks.',
    template: MVP_SCOPE_TEMPLATE,
  }),
  artifactTemplateSchema.parse({
    id: 'readiness-assessment',
    type: 'artifact_template',
    name: 'Readiness Assessment',
    description:
      'The Discovery diagnostic card: clarity/evidence/risk scores, agent readiness and the recommended autonomy level and workflow.',
    template: READINESS_ASSESSMENT_TEMPLATE,
  }),
];

/** Prompt used by the Discovery synthesis phase (`metadata.kind: 'summary'`). */
export const DISCOVERY_SYNTHESIS_PROMPT: PromptTemplateDefinition = {
  id: 'discovery-synthesis',
  type: 'prompt_template',
  name: 'Discovery Synthesis',
  description:
    'Synthesizes a Discovery session (input + question transcript) into the discovery-summary artifact.',
  template: `You are the Discovery reviewer in the Excalibur Discovery flow.

Synthesize the Discovery session below into a concise, practical summary.

Input type: {{inputType}}
Title: {{title}}

## Original input
{{input}}

## Question transcript
{{transcript}}

Write markdown with the sections: Problem, User, Current workaround,
Evidence, Urgency, Scope, Out of scope, Open questions, Recommendation.
Be honest about weak evidence and unclear scope: report unanswered questions
as open questions and never invent answers that were not given. If the work
does not look worth building, say so plainly.
`,
};

const manifest: ExtensionManifest = {
  id: EXTENSION_ID,
  name: 'Discovery Pack',
  version: BUILT_IN_EXTENSION_VERSION,
  kind: 'declarative',
  description:
    'Lightweight pre-work pack for clarifying ideas, tickets and feedback before implementation: question packs, Discovery roles, artifact templates and the synthesis prompt.',
  contributes: {
    questionPacks: questionPackDefinitions.map((definition) => definition.id),
    roleDefinitions: DISCOVERY_ROLE_DEFINITIONS.map((definition) => definition.id),
    artifactTemplates: artifactTemplateDefinitions.map((definition) => definition.id),
    promptTemplates: [DISCOVERY_SYNTHESIS_PROMPT.id],
  },
};

const contributions: Contribution[] = [
  ...questionPackDefinitions.map((definition) =>
    builtInContribution(EXTENSION_ID, 'question_pack', definition.id, definition),
  ),
  ...DISCOVERY_ROLE_DEFINITIONS.map((definition) =>
    builtInContribution(EXTENSION_ID, 'role_definition', definition.id, definition),
  ),
  ...artifactTemplateDefinitions.map((definition) =>
    builtInContribution(EXTENSION_ID, 'artifact_template', definition.id, definition),
  ),
  builtInContribution(
    EXTENSION_ID,
    'prompt_template',
    DISCOVERY_SYNTHESIS_PROMPT.id,
    DISCOVERY_SYNTHESIS_PROMPT,
  ),
];

/**
 * `discovery-pack` — the Discovery question packs (wrapping
 * `DISCOVERY_QUESTION_PACKS`), the six Discovery roles, the
 * refined-ticket/mvp-scope/readiness-assessment artifact templates and the
 * discovery-synthesis prompt.
 */
export const DISCOVERY_PACK: BuiltInExtensionPack = {
  manifest,
  contributions,
};
