/**
 * Built-in workflow catalog: the 14 default workflows (Build Contract §4.2).
 *
 * `fast-fix`, `structured-feature` and `explore-alternatives` are
 * verbatim-normative from the OSS spec §9, `discovery` from the Discovery
 * spec §5 and `ask-repo` follows the Onboarding spec §6.
 */
// GENERATED FILE — do not edit the YAML constants by hand.
// Source of truth: the YAML files at the package root. Regenerate with:
//   node scripts/generate-embedded-catalogs.mjs
import { parseWorkflowYaml } from './parse';
import type { WorkflowDefinition } from './schema';

/** YAML source of the built-in `ask-repo` workflow (mirrored at `default-workflows/ask-repo.yaml`). */
export const ASK_REPO_WORKFLOW_YAML = `id: ask-repo
name: Ask Repo
mode: fast
supportedAutonomyLevels: [1]
description: >
  Answer a question about the repository. Read-only: never modifies files.
phases:
  - id: answer
    name: Answer
    type: assistant_interaction
    role: planner
    modifiesFiles: false
    output: answer.md
`;

/** YAML source of the built-in `review-only` workflow (mirrored at `default-workflows/review-only.yaml`). */
export const REVIEW_ONLY_WORKFLOW_YAML = `id: review-only
name: Review Only
mode: review
supportedAutonomyLevels: [0]
description: >
  Review code or a diff and report findings. Read-only: never modifies files.
phases:
  - id: review
    name: Review
    type: agent_review
    role: reviewer
    modifiesFiles: false
    output: review.md
`;

/** YAML source of the built-in `assist` workflow (mirrored at `default-workflows/assist.yaml`). */
export const ASSIST_WORKFLOW_YAML = `id: assist
name: Assist
mode: fast
supportedAutonomyLevels: [1]
description: >
  Explain code, answer questions and suggest improvements without producing
  automatic diffs.
phases:
  - id: assist
    name: Assist
    type: assistant_interaction
    role: planner
    modifiesFiles: false
    output: answer.md
`;

/** YAML source of the built-in `propose-patch` workflow (mirrored at `default-workflows/propose-patch.yaml`). */
export const PROPOSE_PATCH_WORKFLOW_YAML = `id: propose-patch
name: Propose Patch
mode: standard
supportedAutonomyLevels: [2]
description: >
  Generate a reviewable patch for a task. The patch is never applied
  automatically; the developer decides to apply, branch or reject it.
phases:
  - id: analyze
    name: Analyze
    type: assistant_interaction
    role: reviewer
    modifiesFiles: false
  - id: patch
    name: Patch
    type: patch_generation
    role: implementer
    modifiesFiles: false
    output: diff.patch
  - id: summarize
    name: Summarize
    type: agent_output
    output: summary.md
`;

/** YAML source of the built-in `fast-fix` workflow (mirrored at `default-workflows/fast-fix.yaml`). */
export const FAST_FIX_WORKFLOW_YAML = `id: fast-fix
name: Fast Fix
mode: fast
supportedAutonomyLevels: [2, 3]
phases:
  - id: analyze
    name: Analyze
    type: assistant_interaction
    role: reviewer
    modifiesFiles: false
  - id: patch
    name: Patch
    type: patch_generation
    role: implementer
    modifiesFiles: false
    output: diff.patch
  - id: optional_apply
    name: Optional Apply
    type: apply_patch
    requiresHumanConfirmation: true
  - id: verify
    name: Verify
    type: command_group
    optional: true
    commandsFromConfig: true
  - id: summarize
    name: Summarize
    type: agent_output
    output: summary.md
`;

/** YAML source of the built-in `standard-feature` workflow (mirrored at `default-workflows/standard-feature.yaml`). */
export const STANDARD_FEATURE_WORKFLOW_YAML = `id: standard-feature
name: Standard Feature
mode: standard
supportedAutonomyLevels: [3, 4]
description: >
  Plan, implement and verify a feature in an isolated branch or worktree,
  then document the change, review it and end with a PR summary.
phases:
  - id: plan
    name: Plan
    type: agent_output
    role: planner
    output: plan.md
  - id: implement
    name: Implement
    type: agent_work
    role: implementer
    worktree: true
    agents: 1
  - id: verify
    name: Verify
    type: command_group
    commandsFromConfig: true
  - id: document
    name: Document
    type: agent_work
    role: architect
    output: documentation.md
  - id: review
    name: Review
    type: agent_review
    role: reviewer
    output: review.md
  - id: pr_summary
    name: PR Summary
    type: agent_output
    role: release
    output: pr-summary.md
`;

/** YAML source of the built-in `structured-feature` workflow (mirrored at `default-workflows/structured-feature.yaml`). */
export const STRUCTURED_FEATURE_WORKFLOW_YAML = `id: structured-feature
name: Structured Feature
mode: structured
supportedAutonomyLevels: [3, 4]
phases:
  - id: context
    name: Context Discovery
    type: agent_output
    role: planner
    output: context.md
  - id: spec
    name: Spec
    type: agent_output
    role: planner
    output: spec.md
    approval: optional
  - id: plan
    name: Plan
    type: agent_output
    role: planner
    output: plan.md
    approval: optional
  - id: implement
    name: Implement
    type: agent_work
    role: implementer
    worktree: true
    agents: 1
  - id: verify
    name: Verify
    type: command_group
    commandsFromConfig: true
  - id: review
    name: Review
    type: agent_review
    role: reviewer
    output: review.md
  - id: pr_summary
    name: PR Summary
    type: agent_output
    role: release
    output: pr-summary.md
`;

/** YAML source of the built-in `safe-refactor` workflow (mirrored at `default-workflows/safe-refactor.yaml`). */
export const SAFE_REFACTOR_WORKFLOW_YAML = `id: safe-refactor
name: Safe Refactor
mode: structured
supportedAutonomyLevels: [2, 3, 4]
description: >
  Refactor with no intended behavior change: capture scope and invariants,
  establish a test baseline, refactor in isolation and review the diff.
phases:
  - id: scope
    name: Scope
    type: agent_output
    role: planner
    output: scope.md
  - id: invariants
    name: Invariants
    type: agent_output
    role: architect
    output: invariants.md
  - id: baseline
    name: Baseline Tests
    type: command_group
    commandsFromConfig: true
  - id: refactor
    name: Refactor
    type: agent_work
    role: implementer
    worktree: true
  - id: verify
    name: Verify
    type: command_group
    commandsFromConfig: true
  - id: document
    name: Document
    type: agent_work
    role: architect
    optional: true
    output: documentation.md
  - id: diff_review
    name: Diff Review
    type: agent_review
    role: reviewer
    output: review.md
`;

/** YAML source of the built-in `pr-review` workflow (mirrored at `default-workflows/pr-review.yaml`). */
export const PR_REVIEW_WORKFLOW_YAML = `id: pr-review
name: PR Review
mode: review
supportedAutonomyLevels: [0, 1]
description: >
  Review a pull request or local diff and produce structured findings.
  Read-only: never modifies files.
phases:
  - id: context
    name: Context
    type: agent_output
    role: planner
    modifiesFiles: false
    output: context.md
  - id: review
    name: Review Diff
    type: agent_review
    role: reviewer
    modifiesFiles: false
    output: review.md
`;

/** YAML source of the built-in `security-review` workflow (mirrored at `default-workflows/security-review.yaml`). */
export const SECURITY_REVIEW_WORKFLOW_YAML = `id: security-review
name: Security Review
mode: structured
supportedAutonomyLevels: [0, 1, 2, 3, 4]
description: >
  Security-first flow for sensitive changes: risk analysis and plan first,
  optional isolated implementation, then a dedicated security review, tests
  and a mandatory human approval.
phases:
  - id: risk_analysis
    name: Risk Analysis
    type: agent_output
    role: security
    output: risk-analysis.md
  - id: plan
    name: Plan
    type: agent_output
    role: planner
    output: plan.md
    approval: optional
  - id: implement
    name: Implement
    type: agent_work
    role: implementer
    worktree: true
    optional: true
  - id: security_review
    name: Security Review
    type: agent_review
    role: security
    output: review.md
  - id: verify
    name: Verify
    type: command_group
    optional: true
    commandsFromConfig: true
  - id: document
    name: Document
    type: agent_work
    role: architect
    output: documentation.md
  - id: approve
    name: Human Approval
    type: human_approval
    approval: required
`;

/** YAML source of the built-in `migration` workflow (mirrored at `default-workflows/migration.yaml`). */
export const MIGRATION_WORKFLOW_YAML = `id: migration
name: Migration
mode: structured
supportedAutonomyLevels: [3, 4]
description: >
  Plan and execute a migration with a backward-compatibility check,
  rollback notes, tests, documentation and review.
phases:
  - id: migration_plan
    name: Migration Plan
    type: agent_output
    role: planner
    output: migration-plan.md
    approval: optional
  - id: compatibility
    name: Backward Compatibility Check
    type: agent_output
    role: architect
    output: compatibility.md
  - id: implement
    name: Implement
    type: agent_work
    role: implementer
    worktree: true
  - id: rollback_notes
    name: Rollback Notes
    type: agent_output
    role: implementer
    output: rollback-notes.md
  - id: verify
    name: Verify
    type: command_group
    commandsFromConfig: true
  - id: document
    name: Document
    type: agent_work
    role: architect
    output: documentation.md
  - id: review
    name: Review
    type: agent_review
    role: reviewer
    output: review.md
`;

/** YAML source of the built-in `explore-alternatives` workflow (mirrored at `default-workflows/explore-alternatives.yaml`). */
export const EXPLORE_ALTERNATIVES_WORKFLOW_YAML = `id: explore-alternatives
name: Explore Alternatives
mode: explore
supportedAutonomyLevels: [3, 4]
phases:
  - id: understand
    name: Understand Task
    type: agent_output
    role: planner
    output: context.md
  - id: alternatives
    name: Generate Alternatives
    type: agent_output
    role: architect
    output: alternatives.md
  - id: choose
    name: Choose Approach
    type: human_approval
    optional: true
  - id: implement
    name: Implement Selected Approach
    type: agent_work
    role: implementer
    worktree: true
  - id: verify
    name: Verify
    type: command_group
    commandsFromConfig: true
  - id: summarize
    name: Summarize
    type: agent_output
    output: summary.md
`;

/** YAML source of the built-in `human-gated` workflow (mirrored at `default-workflows/human-gated.yaml`). */
export const HUMAN_GATED_WORKFLOW_YAML = `id: human-gated
name: Human-Gated Agentic Workflow
mode: structured
supportedAutonomyLevels: [3, 4]
description: >
  Full agentic workflow with mandatory human approval gates before
  implementation and before the pull request.
phases:
  - id: plan
    name: Plan
    type: agent_output
    role: planner
    output: plan.md
  - id: approve_plan
    name: Approve Plan
    type: human_approval
    approval: required
  - id: implement
    name: Implement
    type: agent_work
    role: implementer
    worktree: true
  - id: verify
    name: Verify
    type: command_group
    commandsFromConfig: true
  - id: approve_changes
    name: Approve Changes
    type: human_approval
    approval: required
  - id: pull_request
    name: Pull Request
    type: pull_request
    role: release
    output: pr-summary.md
`;

/** YAML source of the built-in `discovery` workflow (mirrored at `default-workflows/discovery.yaml`). */
export const DISCOVERY_WORKFLOW_YAML = `id: discovery
name: Discovery
mode: discovery
supportedAutonomyLevels: [0, 1]
description: >
  Lightweight conversational pre-work flow to clarify ideas, tickets, feedback or technical initiatives before implementation.
phases:
  - id: intake
    name: Intake
    type: assistant_interaction
    role: product_strategist
    modifiesFiles: false
    output: intake.md
  - id: questions
    name: Guided Questions
    type: discovery_questions
    role: product_strategist
    modifiesFiles: false
    output: transcript.md
  - id: synthesis
    name: Synthesis
    type: agent_output
    role: discovery_reviewer
    modifiesFiles: false
    output: discovery-summary.md
  - id: readiness
    name: Readiness Assessment
    type: agent_output
    role: scope_guardian
    modifiesFiles: false
    output: readiness-assessment.md
  - id: recommendation
    name: Recommendation
    type: agent_output
    role: scope_guardian
    modifiesFiles: false
    output: recommendation.md
`;

export const DEFAULT_WORKFLOWS: ReadonlyArray<{
  id: string;
  yaml: string;
  definition: WorkflowDefinition;
}> = [
  {
    id: 'ask-repo',
    yaml: ASK_REPO_WORKFLOW_YAML,
    definition: parseWorkflowYaml(ASK_REPO_WORKFLOW_YAML),
  },
  {
    id: 'review-only',
    yaml: REVIEW_ONLY_WORKFLOW_YAML,
    definition: parseWorkflowYaml(REVIEW_ONLY_WORKFLOW_YAML),
  },
  { id: 'assist', yaml: ASSIST_WORKFLOW_YAML, definition: parseWorkflowYaml(ASSIST_WORKFLOW_YAML) },
  {
    id: 'propose-patch',
    yaml: PROPOSE_PATCH_WORKFLOW_YAML,
    definition: parseWorkflowYaml(PROPOSE_PATCH_WORKFLOW_YAML),
  },
  {
    id: 'fast-fix',
    yaml: FAST_FIX_WORKFLOW_YAML,
    definition: parseWorkflowYaml(FAST_FIX_WORKFLOW_YAML),
  },
  {
    id: 'standard-feature',
    yaml: STANDARD_FEATURE_WORKFLOW_YAML,
    definition: parseWorkflowYaml(STANDARD_FEATURE_WORKFLOW_YAML),
  },
  {
    id: 'structured-feature',
    yaml: STRUCTURED_FEATURE_WORKFLOW_YAML,
    definition: parseWorkflowYaml(STRUCTURED_FEATURE_WORKFLOW_YAML),
  },
  {
    id: 'safe-refactor',
    yaml: SAFE_REFACTOR_WORKFLOW_YAML,
    definition: parseWorkflowYaml(SAFE_REFACTOR_WORKFLOW_YAML),
  },
  {
    id: 'pr-review',
    yaml: PR_REVIEW_WORKFLOW_YAML,
    definition: parseWorkflowYaml(PR_REVIEW_WORKFLOW_YAML),
  },
  {
    id: 'security-review',
    yaml: SECURITY_REVIEW_WORKFLOW_YAML,
    definition: parseWorkflowYaml(SECURITY_REVIEW_WORKFLOW_YAML),
  },
  {
    id: 'migration',
    yaml: MIGRATION_WORKFLOW_YAML,
    definition: parseWorkflowYaml(MIGRATION_WORKFLOW_YAML),
  },
  {
    id: 'explore-alternatives',
    yaml: EXPLORE_ALTERNATIVES_WORKFLOW_YAML,
    definition: parseWorkflowYaml(EXPLORE_ALTERNATIVES_WORKFLOW_YAML),
  },
  {
    id: 'human-gated',
    yaml: HUMAN_GATED_WORKFLOW_YAML,
    definition: parseWorkflowYaml(HUMAN_GATED_WORKFLOW_YAML),
  },
  {
    id: 'discovery',
    yaml: DISCOVERY_WORKFLOW_YAML,
    definition: parseWorkflowYaml(DISCOVERY_WORKFLOW_YAML),
  },
];

const workflowsById = new Map(DEFAULT_WORKFLOWS.map((entry) => [entry.id, entry.definition]));

/** Look up a built-in workflow definition by id. */
export function getDefaultWorkflow(id: string): WorkflowDefinition | undefined {
  return workflowsById.get(id);
}
