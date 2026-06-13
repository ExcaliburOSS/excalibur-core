/**
 * Built-in methodology catalog: the 14 default methodologies — the 12 of the
 * OSS spec §7 plus `discovery` (Discovery spec §4, verbatim-normative) and
 * `agentic-agile-light` (Onboarding spec §6). `spec-driven` is
 * verbatim-normative from the OSS spec §8.
 */
// GENERATED FILE — do not edit the YAML constants by hand.
// Source of truth: the YAML files at the package root. Regenerate with:
//   node scripts/generate-embedded-catalogs.mjs
import { parseMethodologyYaml } from './parse';
import type { Methodology } from './schema';

/** YAML source of the built-in `lightweight` methodology (mirrored at `default-methodologies/lightweight.yaml`). */
export const LIGHTWEIGHT_METHODOLOGY_YAML = `id: lightweight
name: Lightweight Assistant
category: delivery
description: >
  Ask questions, get explanations and review suggestions. The AI responds;
  the developer decides what to do with it.
recommendedAutonomyLevels: [0, 1]
useWhen:
  - You need a quick answer about the codebase
  - You want unfamiliar code explained
  - You want suggestions without any code changes
avoidWhen:
  - You already know the change and want a patch
  - The task needs a structured multi-phase workflow
defaultWorkflow: assist
phases:
  - question
  - response
  - decide
artifacts:
  - answer.md
agentRoles:
  - planner
approval:
  beforePr: none
riskProfile: low
`;

/** YAML source of the built-in `review-first` methodology (mirrored at `default-methodologies/review-first.yaml`). */
export const REVIEW_FIRST_METHODOLOGY_YAML = `id: review-first
name: Review-First Development
category: delivery
description: >
  The developer writes the code; the AI reviews diffs and files and the
  developer applies fixes before opening a PR.
recommendedAutonomyLevels: [0, 1, 2]
useWhen:
  - You want a second pair of eyes on your changes
  - Code review capacity is limited
  - You are changing unfamiliar or critical code
avoidWhen:
  - You want the AI to implement the change itself
  - The change is trivial and already covered by tests
defaultWorkflow: review-only
phases:
  - write
  - review
  - fix
  - pr
artifacts:
  - review.md
agentRoles:
  - reviewer
approval:
  beforePr: recommended
riskProfile: low
`;

/** YAML source of the built-in `patch-proposal` methodology (mirrored at `default-methodologies/patch-proposal.yaml`). */
export const PATCH_PROPOSAL_METHODOLOGY_YAML = `id: patch-proposal
name: Patch-Proposal Workflow
category: delivery
description: >
  The AI generates a reviewable patch for a task; a human reviews it and
  decides whether to apply it.
recommendedAutonomyLevels: [2]
useWhen:
  - The change is well understood and narrow
  - You want full control over what lands in the working tree
  - You are evaluating how the AI handles your codebase
avoidWhen:
  - The task needs multi-step implementation with tests
  - The change spans many modules
defaultWorkflow: propose-patch
phases:
  - task
  - patch
  - review
  - apply
artifacts:
  - diff.patch
  - summary.md
agentRoles:
  - reviewer
  - implementer
approval:
  apply: required
riskProfile: low
`;

/** YAML source of the built-in `fast-fix` methodology (mirrored at `default-methodologies/fast-fix.yaml`). */
export const FAST_FIX_METHODOLOGY_YAML = `id: fast-fix
name: Fast Fix
category: delivery
description: >
  Small, well-scoped fixes: analyze, generate a patch in an isolated branch
  or worktree, verify with tests and summarize.
recommendedAutonomyLevels: [2, 3]
useWhen:
  - The bug is small and well scoped
  - The fix is unlikely to affect other modules
  - You want a fast loop with a verifiable diff
avoidWhen:
  - Requirements are ambiguous
  - The change touches sensitive paths
  - The fix requires design decisions
defaultWorkflow: fast-fix
phases:
  - analyze
  - patch
  - verify
  - summarize
artifacts:
  - diff.patch
  - summary.md
  - test-results.json
agentRoles:
  - reviewer
  - implementer
  - tester
approval:
  apply: required
riskProfile: low
`;

/** YAML source of the built-in `plan-then-execute` methodology (mirrored at `default-methodologies/plan-then-execute.yaml`). */
export const PLAN_THEN_EXECUTE_METHODOLOGY_YAML = `id: plan-then-execute
name: Plan-Then-Execute
category: delivery
description: >
  Produce a short plan before implementation, then implement, run tests and
  review the result.
recommendedAutonomyLevels: [3, 4]
useWhen:
  - The task benefits from a brief upfront plan
  - You want a checkpoint before code changes
  - The implementation has a few coordinated steps
avoidWhen:
  - The change is trivial
  - The task needs a full spec and traceability
defaultWorkflow: standard-feature
phases:
  - plan
  - implement
  - verify
  - review
artifacts:
  - plan.md
  - review.md
agentRoles:
  - planner
  - implementer
  - reviewer
  - tester
approval:
  plan: optional
  beforePr: recommended
riskProfile: medium
`;

/** YAML source of the built-in `spec-driven` methodology (mirrored at `default-methodologies/spec-driven.yaml`). */
export const SPEC_DRIVEN_METHODOLOGY_YAML = `id: spec-driven
name: Spec-Driven Development
description: >
  A structured workflow for turning ambiguous tasks into specs, plans, tasks and
  verified implementation.
recommendedAutonomyLevels: [3, 4]
useWhen:
  - Requirements are ambiguous
  - Multiple modules are involved
  - Customer-facing behavior changes
  - The team wants traceability
avoidWhen:
  - Tiny bugfixes
  - Mechanical edits
  - Urgent hotfixes
defaultWorkflow: structured-feature
phases:
  - understand
  - specify
  - plan
  - implement
  - verify
  - review
artifacts:
  - spec.md
  - plan.md
  - tasks.md
  - verification.md
agentRoles:
  - planner
  - implementer
  - reviewer
  - tester
approval:
  spec: optional
  plan: optional
  beforePr: recommended
riskProfile: medium
`;

/** YAML source of the built-in `tdd-agentic` methodology (mirrored at `default-methodologies/tdd-agentic.yaml`). */
export const TDD_AGENTIC_METHODOLOGY_YAML = `id: tdd-agentic
name: Test-Driven Agentic Development
category: delivery
description: >
  Reproduce the problem with a failing test first, implement until tests
  pass, then review. Strong regression protection for critical logic.
recommendedAutonomyLevels: [2, 3, 4]
useWhen:
  - You are fixing a bug and want regression protection
  - The change touches critical business logic
  - The expected behavior can be captured in a test
avoidWhen:
  - The behavior is hard to test automatically
  - The change is purely cosmetic or documentation
defaultWorkflow: standard-feature
phases:
  - reproduce
  - failing_test
  - implement
  - verify
  - review
artifacts:
  - diff.patch
  - test-results.json
  - tests.log
  - review.md
agentRoles:
  - tester
  - implementer
  - reviewer
approval:
  beforePr: recommended
riskProfile: medium
`;

/** YAML source of the built-in `safe-refactor` methodology (mirrored at `default-methodologies/safe-refactor.yaml`). */
export const SAFE_REFACTOR_METHODOLOGY_YAML = `id: safe-refactor
name: Safe Refactor
category: delivery
description: >
  Refactor with no intended behavior change: define scope and invariants,
  capture a baseline with tests, refactor and review the diff against the
  invariants.
recommendedAutonomyLevels: [2, 3, 4]
useWhen:
  - No behavior change is intended
  - The code needs structural cleanup before new work
  - Test coverage exists or can be established first
avoidWhen:
  - Behavior changes are expected
  - There is no way to verify invariants
defaultWorkflow: safe-refactor
phases:
  - scope
  - invariants
  - baseline_tests
  - refactor
  - verify
  - diff_review
artifacts:
  - scope.md
  - invariants.md
  - review.md
  - test-results.json
agentRoles:
  - planner
  - architect
  - implementer
  - reviewer
  - tester
approval:
  beforePr: recommended
riskProfile: medium
`;

/** YAML source of the built-in `security-first` methodology (mirrored at `default-methodologies/security-first.yaml`). */
export const SECURITY_FIRST_METHODOLOGY_YAML = `id: security-first
name: Security-First Workflow
category: delivery
description: >
  For security-sensitive changes: analyze risk, plan, implement carefully,
  run a dedicated security review and tests, and require human approval.
recommendedAutonomyLevels: [0, 1, 2, 3, 4]
useWhen:
  - The change touches auth, payments, contracts or permissions
  - PII or secrets are involved
  - A vulnerability or hardening task is being addressed
avoidWhen:
  - The change has no security surface
  - Speed matters more than depth and the area is not sensitive
defaultWorkflow: security-review
phases:
  - risk_analysis
  - plan
  - implement
  - security_review
  - verify
  - approval
artifacts:
  - risk-analysis.md
  - plan.md
  - review.md
agentRoles:
  - security
  - planner
  - implementer
  - reviewer
approval:
  plan: optional
  beforePr: required
riskProfile: high
`;

/** YAML source of the built-in `migration` methodology (mirrored at `default-methodologies/migration.yaml`). */
export const MIGRATION_METHODOLOGY_YAML = `id: migration
name: Migration Workflow
category: delivery
description: >
  Plan and execute schema or infrastructure migrations with a backward
  compatibility check, rollback notes and verification.
recommendedAutonomyLevels: [3, 4]
useWhen:
  - A database schema or data migration is required
  - Infrastructure or dependency migrations need care
  - Backward compatibility must be preserved
avoidWhen:
  - The change does not alter persisted state or infrastructure
  - A simple code-only fix is enough
defaultWorkflow: migration
phases:
  - migration_plan
  - compatibility_check
  - implement
  - rollback_notes
  - verify
artifacts:
  - migration-plan.md
  - compatibility.md
  - rollback-notes.md
  - test-results.json
agentRoles:
  - planner
  - architect
  - implementer
  - tester
  - reviewer
approval:
  migrationPlan: recommended
  beforePr: required
riskProfile: high
`;

/** YAML source of the built-in `explore-then-choose` methodology (mirrored at `default-methodologies/explore-then-choose.yaml`). */
export const EXPLORE_THEN_CHOOSE_METHODOLOGY_YAML = `id: explore-then-choose
name: Explore Alternatives
category: delivery
description: >
  Generate and compare engineering approaches before committing: understand
  the task, present alternatives with trade-offs, choose one and implement
  it. Present results as approach exploration, never as model comparison.
recommendedAutonomyLevels: [3, 4]
useWhen:
  - The decision is complex with several viable designs
  - Trade-offs need to be explicit before implementation
  - The team disagrees on the approach
avoidWhen:
  - One approach is clearly correct
  - The change is small or mechanical
defaultWorkflow: explore-alternatives
phases:
  - understand
  - alternatives
  - compare
  - choose
  - implement
  - verify
artifacts:
  - context.md
  - alternatives.md
  - summary.md
agentRoles:
  - planner
  - architect
  - implementer
  - reviewer
approval:
  choose: recommended
riskProfile: medium
`;

/** YAML source of the built-in `human-gated` methodology (mirrored at `default-methodologies/human-gated.yaml`). */
export const HUMAN_GATED_METHODOLOGY_YAML = `id: human-gated
name: Human-Gated Agentic Workflow
category: delivery
description: >
  Full agentic implementation with mandatory human approvals: the plan is
  approved before implementation and the result is approved before the PR.
recommendedAutonomyLevels: [3, 4]
useWhen:
  - High-stakes changes need explicit human checkpoints
  - Compliance or team policy requires approvals
  - You are building trust in agentic execution
avoidWhen:
  - The change is small and low risk
  - Approval latency would block urgent work
defaultWorkflow: human-gated
phases:
  - plan
  - approve_plan
  - implement
  - verify
  - approve_changes
  - pr
artifacts:
  - plan.md
  - review.md
  - pr-summary.md
agentRoles:
  - planner
  - implementer
  - reviewer
  - release
approval:
  plan: required
  beforePr: required
riskProfile: high
`;

/** YAML source of the built-in `discovery` methodology (mirrored at `default-methodologies/discovery.yaml`). */
export const DISCOVERY_METHODOLOGY_YAML = `id: discovery
name: Discovery
category: pre_work
description: >
  A lightweight methodology to clarify ideas, tickets, feedback or technical initiatives before implementation.
recommendedAutonomyLevels: [0, 1]
useWhen:
  - The idea is ambiguous
  - The target user or problem is unclear
  - A ticket lacks acceptance criteria
  - Customer feedback needs synthesis
  - A technical initiative needs framing
  - The team is unsure whether an agent should implement it
  - The work may need validation before build
avoidWhen:
  - The task is a clear bugfix
  - The change is mechanical
  - The ticket is already implementation-ready
  - The work is urgent and well scoped
defaultWorkflow: discovery
phases:
  - intake
  - questions
  - synthesis
  - readiness
  - recommendation
outputs:
  - discovery-summary.md
  - refined-ticket.md
  - acceptance-criteria.md
  - mvp-scope.md
  - readiness-assessment.md
  - recommendation.md
modes:
  - product_idea
  - existing_work_item
  - customer_feedback
  - technical_initiative
  - incident
  - agent_readiness
  - mvp_scope
questions:
  - id: problem
    text: What problem are we trying to solve?
  - id: user
    text: Who has this problem?
  - id: current_workaround
    text: What do they do today?
  - id: urgency
    text: Why does it matter now?
  - id: mvp
    text: What is the smallest useful version?
  - id: out_of_scope
    text: What is explicitly out of scope?
  - id: success
    text: How will we know it worked?
  - id: evidence
    text: What evidence do we have?
  - id: readiness
    text: Is this ready for implementation by a human or an agent?
riskProfile: low
`;

/** YAML source of the built-in `agentic-agile-light` methodology (mirrored at `default-methodologies/agentic-agile-light.yaml`). */
export const AGENTIC_AGILE_LIGHT_METHODOLOGY_YAML = `id: agentic-agile-light
name: Agentic Agile (Light)
category: delivery
description: >
  Lightweight async agile rituals for agentic development: local daily
  summaries and weekly plans generated from runs, patches and git activity.
  A facilitation layer — it never imposes a specific agile process.
recommendedAutonomyLevels: [0, 1]
useWhen:
  - The team wants async visibility without extra meetings
  - You want daily summaries of local AI-assisted work
  - You want a lightweight weekly plan from recent activity
avoidWhen:
  - You need enterprise planning, scheduling or governance
  - The team is happy with its existing agile tooling
defaultWorkflow: ask-repo
phases:
  - daily_summary
  - weekly_planning
outputs:
  - reports/daily-YYYY-MM-DD.md
  - reports/weekly-plan-YYYY-Www.md
agentRoles:
  - planner
approval:
  beforePr: none
riskProfile: low
`;

export const DEFAULT_METHODOLOGIES: ReadonlyArray<{
  id: string;
  yaml: string;
  definition: Methodology;
}> = [
  { id: 'lightweight', yaml: LIGHTWEIGHT_METHODOLOGY_YAML, definition: parseMethodologyYaml(LIGHTWEIGHT_METHODOLOGY_YAML) },
  { id: 'review-first', yaml: REVIEW_FIRST_METHODOLOGY_YAML, definition: parseMethodologyYaml(REVIEW_FIRST_METHODOLOGY_YAML) },
  { id: 'patch-proposal', yaml: PATCH_PROPOSAL_METHODOLOGY_YAML, definition: parseMethodologyYaml(PATCH_PROPOSAL_METHODOLOGY_YAML) },
  { id: 'fast-fix', yaml: FAST_FIX_METHODOLOGY_YAML, definition: parseMethodologyYaml(FAST_FIX_METHODOLOGY_YAML) },
  { id: 'plan-then-execute', yaml: PLAN_THEN_EXECUTE_METHODOLOGY_YAML, definition: parseMethodologyYaml(PLAN_THEN_EXECUTE_METHODOLOGY_YAML) },
  { id: 'spec-driven', yaml: SPEC_DRIVEN_METHODOLOGY_YAML, definition: parseMethodologyYaml(SPEC_DRIVEN_METHODOLOGY_YAML) },
  { id: 'tdd-agentic', yaml: TDD_AGENTIC_METHODOLOGY_YAML, definition: parseMethodologyYaml(TDD_AGENTIC_METHODOLOGY_YAML) },
  { id: 'safe-refactor', yaml: SAFE_REFACTOR_METHODOLOGY_YAML, definition: parseMethodologyYaml(SAFE_REFACTOR_METHODOLOGY_YAML) },
  { id: 'security-first', yaml: SECURITY_FIRST_METHODOLOGY_YAML, definition: parseMethodologyYaml(SECURITY_FIRST_METHODOLOGY_YAML) },
  { id: 'migration', yaml: MIGRATION_METHODOLOGY_YAML, definition: parseMethodologyYaml(MIGRATION_METHODOLOGY_YAML) },
  { id: 'explore-then-choose', yaml: EXPLORE_THEN_CHOOSE_METHODOLOGY_YAML, definition: parseMethodologyYaml(EXPLORE_THEN_CHOOSE_METHODOLOGY_YAML) },
  { id: 'human-gated', yaml: HUMAN_GATED_METHODOLOGY_YAML, definition: parseMethodologyYaml(HUMAN_GATED_METHODOLOGY_YAML) },
  { id: 'discovery', yaml: DISCOVERY_METHODOLOGY_YAML, definition: parseMethodologyYaml(DISCOVERY_METHODOLOGY_YAML) },
  { id: 'agentic-agile-light', yaml: AGENTIC_AGILE_LIGHT_METHODOLOGY_YAML, definition: parseMethodologyYaml(AGENTIC_AGILE_LIGHT_METHODOLOGY_YAML) },
];

const methodologiesById = new Map(DEFAULT_METHODOLOGIES.map((entry) => [entry.id, entry.definition]));

/** Look up a built-in methodology definition by id. */
export function getDefaultMethodology(id: string): Methodology | undefined {
  return methodologiesById.get(id);
}
