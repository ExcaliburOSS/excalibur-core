# Creating a Methodology

A methodology is **conceptual**: it captures how your team decides to work —
when to use an approach, what artifacts it produces, what must be approved.
A workflow is **executable** (ordered phases the engine runs). A methodology
typically names its `defaultWorkflow`.

Methodologies are declarative YAML — no SDK, no code. They use the exact
schema of the 14 built-ins (`@excalibur/workflow-schema`).

## 1. Write the YAML

```yaml
id: safe-refactor-strict
type: methodology # optional in .excalibur/methodologies/, recommended
name: Safe Refactor (Strict)
category: delivery # free-form; defaults to 'delivery'; Discovery uses 'pre_work'
description: > # required
  Refactor with no intended behavior change, gated by humans at both ends.
recommendedAutonomyLevels: [2, 3] # 0..4
useWhen:
  - No behavior change is intended
  - The code is load-bearing and weakly tested
avoidWhen:
  - Behavior changes are expected
defaultWorkflow: safe-refactor-strict
workflows: [safe-refactor-strict] # all workflows this methodology may use
phases: # conceptual phase names (not executable)
  - scope
  - invariants
  - refactor
artifacts: [scope.md, invariants.md, review.md]
questions: # questions the team should answer before starting
  - id: invariants
    text: Which observable behaviors must remain identical?
agentRoles: [planner, architect, implementer, reviewer]
approval: # free-form keys → required|optional|recommended|none
  beforeApply: required
riskProfile: medium # low|medium|high, defaults to medium
```

Field reference: `id`, `name`, `description` are required; everything else
is optional. `agentRoles` entries must be valid agent roles (`planner`,
`architect`, `implementer`, `reviewer`, `tester`, `security`, `release`, the
six Discovery roles, or `custom`). `outputs`, `modes`, `roles` (free-form
strings) and `scoring` are also accepted — see the built-in
`discovery.yaml` for a fully-populated example
(`packages/workflow-schema/default-methodologies/`).

## 2. Ship it

Either drop the file into `.excalibur/methodologies/`, or package it with a
manifest (see
[`examples/extensions/declarative-safe-refactor`](../../examples/extensions/declarative-safe-refactor/)):

```yaml
# excalibur.extension.yaml
id: my-team-methodologies
name: My Team Methodologies
version: 0.1.0
kind: declarative
contributes:
  methodologies:
    - ./methodologies/safe-refactor-strict.yaml
```

You can also scaffold the whole layout:

```bash
excalibur extensions create methodology safe-refactor-strict
```

## 3. Validate and use it

```bash
excalibur extensions validate
excalibur methodologies list        # shows it next to the built-ins, with source
```

Reusing a built-in id (e.g. `safe-refactor`) **overrides** the built-in
methodology — project and local files win over built-ins. Pick a new id to
add instead of replace.

## Pair it with a workflow

If your methodology names a `defaultWorkflow` that is not a built-in, ship
the workflow in the same extension — see
[creating-a-workflow.md](./creating-a-workflow.md).
