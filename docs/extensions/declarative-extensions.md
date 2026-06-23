# Declarative Extensions

Declarative extensions are plain YAML or Markdown files. No code runs: they
are data, validated against zod schemas, and therefore safe to copy between
repositories, review in pull requests and edit without a build step.

## Where files live

Two equivalent ways to ship declarative content:

**1. Loose files** in the ten `.excalibur/` declarative directories. The
directory determines the expected type, so the `type:` field may be omitted:

| Directory                      | Declarative type                                                          |
| ------------------------------ | ------------------------------------------------------------------------- |
| `.excalibur/methodologies/`    | `methodology`                                                             |
| `.excalibur/workflows/`        | `workflow`                                                                |
| `.excalibur/question-packs/`   | `question_pack`                                                           |
| `.excalibur/prompts/`          | `prompt_template`                                                         |
| `.excalibur/artifacts/`        | `artifact_template`                                                       |
| `.excalibur/policies/`         | `policy_preset`                                                           |
| `.excalibur/models/`           | `model_routing` (`providers.yaml` is skipped — it is the provider config) |
| `.excalibur/reports/`          | `report_template`                                                         |
| `.excalibur/roles/`            | `role_definition`                                                         |
| `.excalibur/command-mappings/` | `command_mapping`                                                         |

Extra files outside those directories can be added explicitly in
`.excalibur/extensions.yaml` (paths relative to `.excalibur/`):

```yaml
declarative:
  - ./methodologies/discovery.yaml
  - ../docs/prompts/release-notes.md
```

**2. Extension packs**: a directory with an `excalibur.extension.yaml`
manifest (`kind: declarative`) whose `contributes` keys reference the files.
Packs are the unit you install (`excalibur extensions install <path>`) and
share. See [extension-manifest.md](./extension-manifest.md).

## The 10 types

All definitions share `id` (non-empty string, unique per type) and a `type`
discriminator. Unknown YAML keys are tolerated and stripped, so teams can
annotate files freely.

### `methodology` and `workflow`

Owned by `@excalibur/workflow-schema` (the same schemas the 14 built-ins
use); `type` is optional on these two. See
[creating-a-methodology.md](./creating-a-methodology.md) and
[creating-a-workflow.md](./creating-a-workflow.md).

### `question_pack`

```yaml
id: agent-readiness
type: question_pack
name: Agent Readiness
description: Optional.
questions: # at least one
  - id: problem
    text: Is the goal clear enough for an agent?
```

### `prompt_template`

YAML (`{ id, type, name, template }`, `template` non-empty) **or** a Markdown
file (see below).

### `artifact_template`

Markdown with `{{variable}}` placeholders, or a YAML wrapper
(`{ id, type, template, name?, variables? }`). `variables` is always
**auto-extracted** from the `{{...}}` placeholders in order of first
appearance; explicitly declared variables not present in the body are kept
after the extracted ones. Placeholder names may contain word characters,
dots and dashes (`{{scores.clarity}}`, `{{ticket-id}}`); inner whitespace is
tolerated (`{{ user }}`).

### `policy_preset`

```yaml
id: standard-safe
type: policy_preset
rules: # at least one
  - id: block-secrets
    when: # empty `when` matches everything
      filePathMatches: ['**/*.pem'] # optional
      action: read # optional
      command: pnpm test # optional
    decision: deny # allow | deny | redact | require_approval
```

### `model_routing`

```yaml
id: default-routing
type: model_routing
default: kimi # all fields optional; each value is a provider key from providers.yaml
byRole: { planner: kimi, implementer: minimax }
byPath: { 'src/billing/**': local-secure }
byWorkflow: { security-review: local-secure }
```

### `report_template`

`{ id, type, name, sections: string[] }` — at least one section.

### `role_definition`

`{ id, type, name, description }` — all required.

### `command_mapping`

```yaml
id: work-item-commands
type: command_mapping
commands: # at least one
  - trigger: '@excalibur run'
    action: run
    defaults: { autonomyLevel: 3, executionStyle: team_default }
```

## Markdown files

A Markdown file can define a `prompt_template` or an `artifact_template`
(only those two — other types need YAML). Resolution rules, in order:

- **Type**: front-matter `type:` wins; otherwise the closest directory hint
  (`prompts/` or `prompt-templates/` → prompt, `artifacts/` or
  `artifact-templates/` → artifact); otherwise a readable error.
- **Id**: front-matter `id:`, else the file name without `.md`/`.markdown`
  (`pr-summary.md` → `pr-summary`).
- **Name**: front-matter `name:`, else humanized from the id
  (`refined-ticket` → `Refined Ticket`).
- **Template**: the body below the front matter, trimmed. It must be
  non-empty.

```markdown
---
name: Pull Request Summary (team format)
description: Optional description.
---

Summarize the change below…

{{task}}
```

## Validation and errors

Every file is validated on load. Parsing failures throw (or, inside the
loader, record) a `WorkflowValidationError` with the file path, the offending
field path and the problem — e.g.
`Invalid question_pack definition "bad-pack": questions[0].text: …`.

Check everything reachable from your repo at once:

```bash
excalibur extensions validate   # exit code 2 when anything is invalid
```

## Overrides

Contribution ids are the override key. A project or local file whose id
matches a built-in contribution **replaces** it (later sources win:
`built_in` < `project` < `local`). Same-source duplicates are ignored with a
warning. `excalibur extensions list` shows which source won for each
contribution.

Working examples: [`examples/extensions/declarative-discovery-pack`](../../examples/extensions/declarative-discovery-pack/),
[`declarative-safe-refactor`](../../examples/extensions/declarative-safe-refactor/),
[`declarative-fast-fix-workflow`](../../examples/extensions/declarative-fast-fix-workflow/),
[`declarative-pr-summary-template`](../../examples/extensions/declarative-pr-summary-template/).
