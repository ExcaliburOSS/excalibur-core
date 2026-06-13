# declarative-safe-refactor (example)

A declarative extension that ships a **methodology and the workflow it
prescribes** as one pack:

| File | Contribution | Id |
|---|---|---|
| `methodologies/safe-refactor-strict.yaml` | `methodology` | `safe-refactor-strict` |
| `workflows/safe-refactor-strict.yaml` | `workflow` | `safe-refactor-strict` |

`safe-refactor-strict` is a stricter variant of the built-in `safe-refactor`
flow: a required `human_approval` phase gates the refactor after the plan
(scope + invariants), and a second required approval gates the end of the run
after the diff review. Both definitions use new ids, so the built-in
`safe-refactor` stays available unchanged.

## What it demonstrates

- A methodology (`type: methodology`) that names its `defaultWorkflow` and
  pairs `useWhen`/`avoidWhen` guidance, conceptual `phases`, `artifacts`,
  `questions` and an `approval` map with a concrete executable workflow.
- A workflow (`type: workflow`) using the phase types the engine executes:
  `agent_output`, `human_approval` (with `approval: required`),
  `command_group` (with `commandsFromConfig: true`, resolving the test/lint
  commands detected in `.excalibur/config.yaml`), `agent_work` (with
  `worktree: true`) and `agent_review`.
- That methodologies and workflows need **no SDK and no code** — they are the
  same YAML shapes the 14 built-in workflows and methodologies use.

## Try it

```bash
excalibur extensions install examples/extensions/declarative-safe-refactor
excalibur extensions validate

# Both show up next to the built-ins, with their source column:
excalibur methodologies list
excalibur workflows explain safe-refactor-strict

# Run it (M1 executes the run with the mock provider and simulated commands):
excalibur run "Extract the retry logic from escrow.service.ts" --workflow safe-refactor-strict
```

Alternatively, skip the pack and drop the two YAML files directly into
`.excalibur/methodologies/` and `.excalibur/workflows/` — loose declarative
files in those directories load exactly the same way.

See `docs/extensions/creating-a-methodology.md` and
`docs/extensions/creating-a-workflow.md` for the full field reference.
