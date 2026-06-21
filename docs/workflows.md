# Workflows

A **workflow** is executable: an ordered list of phases with declared types, roles, approvals and artifacts. (A _methodology_ is the conceptual counterpart — see [methodologies.md](methodologies.md).)

```bash
excalibur workflows list
excalibur workflows explain standard-feature
```

The catalog comes from the extension host: the 14 built-ins are registered as extension packs, and any YAML you place in `.excalibur/workflows/` overrides or extends them with zero special-casing (same `id` = override; `workflows list` shows the source column).

## Built-in catalog (14)

| ID                     | Mode       | Levels | Purpose                                                                  |
| ---------------------- | ---------- | ------ | ------------------------------------------------------------------------ |
| `ask-repo`             | fast       | 1      | Answer a question about the repository                                   |
| `review-only`          | review     | 0      | Review code/diffs; never changes anything                                |
| `assist`               | fast       | 1      | Explain and suggest                                                      |
| `propose-patch`        | standard   | 2      | Analyze → generate diff → human decides                                  |
| `fast-fix`             | fast       | 2–3    | Analyze → patch → optional apply → verify → summary                      |
| `standard-feature`     | standard   | 3–4    | Context → plan → implement → verify → review → PR summary                |
| `structured-feature`   | structured | 3–4    | Context → spec → plan → implement → verify → review → PR summary         |
| `safe-refactor`        | standard   | 2–4    | Invariants → baseline tests → refactor → verify → diff review            |
| `pr-review`            | review     | 0–1    | Review an existing change set                                            |
| `security-review`      | review     | 0–4    | Risk analysis → review → human approval                                  |
| `migration`            | structured | 3–4    | Plan → backward-compat check → implement → rollback notes → verify       |
| `explore-alternatives` | explore    | 3–4    | Generate approaches → compare trade-offs → choose → implement            |
| `human-gated`          | structured | 3–4    | Plan → **human approval** → implement → verify → **human approval** → PR |
| `discovery`            | discovery  | 0–1    | Intake → guided questions → synthesis → readiness → recommendation       |

## Anatomy of a workflow

```yaml
id: fast-fix
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
    output: diff.patch
  - id: optional_apply
    name: Optional Apply
    type: apply_patch
    requiresHumanConfirmation: true
  - id: verify
    name: Verify
    type: command_group
    optional: true
    commandsFromConfig: true # uses your detected test/lint commands
  - id: summarize
    name: Summarize
    type: agent_output
    output: summary.md
```

Phase types: `assistant_interaction`, `patch_generation`, `agent_output`, `agent_work`, `agent_review`, `command_group`, `human_approval`, `apply_patch`, `pull_request`, `discovery_questions`, `custom`.

Phase options worth knowing:

- `approval: required | optional | none` — human gates.
- `requiresHumanConfirmation: true` — confirm before the phase acts.
- `commandsFromConfig: true` — run the commands detected in `config.yaml`.
- `optional: true` — the phase may be skipped without failing the run.
- `onFailure: abort | continue | retry`.

## How a workflow is selected

1. `--workflow <id>` always wins.
2. `workflows.byPath` patterns from config.
3. The autonomy level + execution style mapping (see [autonomy-levels.md](autonomy-levels.md)), informed by the task-intent classifier — small bugfixes get `fast-fix`, sensitive tasks get careful workflows, ambiguous tasks get a Discovery recommendation.

The run prompt always shows the choice before executing:

```text
Using: Fast Fix (fast-fix)
Autonomy: Level 3 — Implement in Branch
Safety: standard-safe — No files will be modified without approval.
[Enter] continue  [m] change mode  [c] cancel
```

## Custom workflows

```bash
excalibur extensions create workflow safe-hotfix
# edit .excalibur/extensions/safe-hotfix/workflows/safe-hotfix.yaml
excalibur extensions validate
excalibur run "Fix webhook retry" --workflow safe-hotfix
```

Or simply drop a YAML file into `.excalibur/workflows/`. See [extensions/creating-a-workflow.md](extensions/creating-a-workflow.md).

## Run artifacts

Every run writes `.excalibur/runs/<run-id>/` with `run.json`, `workflow.yaml`, `events.jsonl` (the canonical 30-type event format shared with Excalibur Enterprise), `model-calls.jsonl`, `input.md`, plus the artifacts its phases declare (`diff.patch`, `summary.md`, `review.md`, `test-results.json`, `pr-summary.md`, …). Inspect them with `excalibur logs [runId]`.
