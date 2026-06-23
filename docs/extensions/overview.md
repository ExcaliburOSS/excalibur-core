# Extensions — Overview

Excalibur is an extensible runtime from the beginning. The core principle:

> Not every extension should require code. **YAML/Markdown defines how the
> team works. SDK code connects Excalibur to the outside world.**

There are two kinds of extensions:

1. **Declarative extensions** — YAML, Markdown or JSON files. No code. Safe,
   portable, Git-versionable, editable by tech leads. Ten types:
   `methodology`, `workflow`, `question_pack`, `prompt_template`,
   `artifact_template`, `policy_preset`, `model_routing`, `report_template`,
   `role_definition`, `command_mapping`.
2. **Programmatic extensions** — TypeScript code built with
   `@excalibur-oss/extension-sdk`. For external APIs, auth, runtime behavior.
   Ten contribution kinds: `work_item_provider`, `communication_provider`,
   `model_provider`, `agent_adapter`, `tool`, `context_source`, `exporter`,
   `policy_evaluator`, `vcs_provider`, `enterprise_sync_provider`.

A third manifest kind, `mixed`, combines both: declarative files plus a code
entrypoint in one extension.

## The packages

| Package                          | Role                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@excalibur/declarative-schemas` | zod schemas for the 10 declarative types, a discriminated union on `type`, and the YAML/Markdown parsers (`parseDeclarativeYaml`, `parseDeclarativeMarkdown`).                                                                       |
| `@excalibur/extension-runtime`   | The manifest schema/loader/validator, `ExtensionRegistry` + `ContributionRegistry`, the extension loader (`loadExtensions`), `HookRegistry`, and permission validation.                                                              |
| `@excalibur-oss/extension-sdk`   | `defineExtension`, `ExtensionContext` with its 11 typed registries + hooks/logger/config, and the contribution interfaces (`CommunicationProvider`, `AgentTool`, `ContextSource`, `PolicyEvaluator`, `ReportGenerator`, `Exporter`). |
| `@excalibur/built-in-extensions` | The default catalogs (14 workflows, 14 methodologies, Discovery packs, prompts, the `standard-safe` policy, report templates, command mappings) packaged as seven built-in extension packs.                                          |

Built-ins use the same extension mechanisms as everything else: they flow
through the same `ContributionRegistry`, so a project file can override a
built-in with zero special-casing.

## How extensions are loaded

`loadExtensions({ repoRoot, builtIns })` builds one `ExtensionRegistry` per
repository, in this order (later sources win conflicts):

1. **Built-in packs** (`source: built_in`).
2. **Project declarative files** (`source: project`): every YAML/Markdown
   file in the ten `.excalibur/` declarative directories (`methodologies/`,
   `workflows/`, `question-packs/`, `prompts/`, `artifacts/`, `policies/`,
   `models/`, `reports/`, `roles/`, `command-mappings/`) plus any file listed
   under `declarative:` in `.excalibur/extensions.yaml`.
   (`.excalibur/models/providers.yaml` is the model _provider_ config, not a
   declarative file, and is skipped.)
3. **Local programmatic extensions** (`source: local`): directories listed
   under `local:` in `extensions.yaml` and every
   `.excalibur/extensions/<dir>/` carrying an `excalibur.extension.yaml`.
   Compiled entrypoints are `require`d; load failures are recorded on the
   extension (`status: 'error'`), never thrown.
4. **npm-installed extensions** — arrives with the npm ecosystem milestone (M8).
5. **Enterprise-managed extensions** — arrives with Excalibur Enterprise (M5+).

Conflict rules:

- Same contribution id from a **later source** overrides the earlier one
  (project overrides built-in, local overrides project).
- Duplicate id from the **same source** is ignored, with a recorded warning.
- Definitions that fail schema validation are rejected with a recorded
  warning; they never crash the load. Warnings are visible via
  `excalibur extensions list` and `excalibur extensions doctor`.

`.excalibur/extensions.yaml` controls enablement: `disabled:` ids are
skipped entirely (in M1 every discovered extension is enabled unless
disabled; the `enabled:` list is advisory).

## What works in M1 (today) vs later

| Capability                                                         | Status                                        |
| ------------------------------------------------------------------ | --------------------------------------------- |
| All 10 declarative types, loose files and packs                    | Works today                                   |
| Manifest validation (`excalibur extensions validate`)              | Works today                                   |
| Local programmatic extensions with a **compiled** entrypoint       | Works today (loaded and validated; see below) |
| Contribution override rules, warnings, hooks registry              | Works today                                   |
| Permission **validation** + warnings                               | Works today                                   |
| Permission **enforcement**                                         | M5 (Enterprise policy engine)                 |
| Real work-item/communication/model providers calling external APIs | M2–M4                                         |
| External agent execution (custom command agents)                   | M3                                            |
| Installing extensions from npm                                     | M8 (npm ecosystem milestone)                  |

## Where to go next

- [Declarative extensions](./declarative-extensions.md) — the 10 file types.
- [Programmatic extensions](./programmatic-extensions.md) — the SDK.
- [The extension manifest](./extension-manifest.md) — `excalibur.extension.yaml` reference.
- Guides: [methodology](./creating-a-methodology.md) ·
  [workflow](./creating-a-workflow.md) ·
  [question pack](./creating-a-question-pack.md) ·
  [work-item provider](./creating-a-work-item-provider.md) ·
  [communication provider](./creating-a-communication-provider.md) ·
  [tool](./creating-a-tool.md)
- [Security model](./security-model.md) · [Testing extensions](./testing-extensions.md) ·
  [Publishing extensions](./publishing-extensions.md)
- Working examples: [`examples/extensions/`](../../examples/extensions/)
