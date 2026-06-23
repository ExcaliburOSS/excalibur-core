# Creating a Workflow

A workflow is an **executable** sequence of phases. The engine runs phases in
order; each phase's `type` determines what happens. Workflows are declarative
YAML using the exact schema of the 14 built-ins.

## 1. Write the YAML

```yaml
id: safe-hotfix
type: workflow # optional in .excalibur/workflows/, recommended
name: Safe Hotfix
mode: fast # fast|standard|structured|explore|review|discovery|custom
supportedAutonomyLevels: [2, 3] # defaults to [0,1,2,3,4]
description: >
  Hotfix flow with mandatory verification before the patch can be applied.
inputs: [task] # optional declared inputs
defaults: # optional
  model: mock
  commands: ['pnpm test']
phases: # at least one
  - id: analyze
    name: Analyze
    type: assistant_interaction
    role: reviewer
    modifiesFiles: false
  - id: patch
    name: Patch
    type: patch_generation
    role: implementer
    output: diff.patch
  - id: verify
    name: Verify
    type: command_group
    commandsFromConfig: true
    onFailure: abort
  - id: apply
    name: Apply Patch
    type: apply_patch
    requiresHumanConfirmation: true
  - id: summarize
    name: Summarize
    type: agent_output
    output: summary.md
```

## Phase types (what the engine does)

| `type`                  | Behavior                                                                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assistant_interaction` | Chat turn via the model gateway; writes the phase `output` artifact.                                                                                                                                                  |
| `agent_output`          | Model-generated artifact (plan, summary, review notes) → `output` file.                                                                                                                                               |
| `agent_review`          | Review pass over the work so far → `output` (e.g. `review.md`).                                                                                                                                                       |
| `agent_work`            | Delegates to the agent adapter and streams its events; collects the generated diff.                                                                                                                                   |
| `patch_generation`      | Produces a unified diff → `diff.patch` + `patch_generated` event.                                                                                                                                                     |
| `command_group`         | Runs the phase `commands` (or the configured project commands with `commandsFromConfig: true`) as **real** processes, gated by the Permission Engine, emitting `command_started`/`command_completed` + `test_result`. |
| `human_approval`        | Emits `approval_requested` and waits for confirmation; a denied **required** approval cancels the run.                                                                                                                |
| `apply_patch`           | Confirms, then **applies the patch** to the working tree and emits `patch_applied`.                                                                                                                                   |
| `pull_request`          | Drafts `pr-summary.md`.                                                                                                                                                                                               |
| `discovery_questions`   | Runs the guided Discovery question pack (Discovery workflow only).                                                                                                                                                    |

## Phase fields

| Field                       | Type / default                                | Notes                                                                                                                  |
| --------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `id`, `name`, `type`        | required                                      |                                                                                                                        |
| `role`                      | agent role                                    | `planner`, `architect`, `implementer`, `reviewer`, `tester`, `security`, `release`, the six Discovery roles, `custom`. |
| `required`                  | bool, default `true`                          | `optional: true` is sugar for `required: false` (the parser normalizes it).                                            |
| `agents`                    | int ≥ 1                                       | Parallel agents for `agent_work` (later milestones).                                                                   |
| `worktree`                  | bool                                          | Run the phase in an isolated branch/worktree.                                                                          |
| `modifiesFiles`             | bool                                          | Declares intent; useful for review tooling.                                                                            |
| `commands`                  | string[]                                      | Explicit commands for `command_group`.                                                                                 |
| `commandsFromConfig`        | bool                                          | Resolve test/lint/typecheck/build from `.excalibur/config.yaml`.                                                       |
| `output`                    | string                                        | Artifact file name (e.g. `summary.md`).                                                                                |
| `approval`                  | `required`\|`optional`\|`none`                | For `human_approval` phases.                                                                                           |
| `requiresHumanConfirmation` | bool                                          | Ask before executing (e.g. `apply_patch`).                                                                             |
| `onFailure`                 | `abort`\|`continue`\|`retry`, default `abort` | With `maxRetries` for `retry`.                                                                                         |

## 2. Ship, validate, run

```bash
# Loose file:
cp safe-hotfix.yaml .excalibur/workflows/

# Or scaffold a pack:
excalibur extensions create workflow safe-hotfix

excalibur extensions validate
excalibur workflows list
excalibur workflows explain safe-hotfix

excalibur run "Fix webhook retry" --workflow safe-hotfix
```

The workflow catalog used by `run`, `init` and workflow selection comes from
the contribution registry, so your file participates immediately — and a
workflow reusing a built-in id (e.g. `fast-fix`) **overrides** the built-in.

Working examples:
[`examples/extensions/declarative-fast-fix-workflow`](../../examples/extensions/declarative-fast-fix-workflow/)
(single workflow) and
[`declarative-safe-refactor`](../../examples/extensions/declarative-safe-refactor/)
(methodology + workflow pair). The 14 built-in YAMLs in
`packages/workflow-schema/default-workflows/` are the canonical style guide.
