# The Extension Manifest (`excalibur.extension.yaml`)

Every extension — declarative pack, programmatic, or mixed — is described by
a manifest named `excalibur.extension.yaml` at the extension's root.

## Fields

| Field          | Type                                                 | Notes                                                                                                                  |
| -------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `id`           | string, required                                     | Stable identifier. Must start with a letter, digit or `@` and contain only letters, digits and `@ / . _ -`.            |
| `name`         | string, required                                     | Human-readable name.                                                                                                   |
| `version`      | string, required                                     | Semver recommended.                                                                                                    |
| `kind`         | `declarative` \| `programmatic` \| `mixed`, required | See kind rules below.                                                                                                  |
| `description`  | string, optional                                     |                                                                                                                        |
| `entrypoint`   | string, optional                                     | Path to **compiled JS** relative to the extension dir (e.g. `dist/index.js`).                                          |
| `contributes`  | object, optional                                     | What the extension provides (see below).                                                                               |
| `capabilities` | string[], optional                                   | Capability identifiers, e.g. `work_items.read`, `communication.post`, `reports.generate`.                              |
| `configSchema` | record, optional                                     | `{ <field>: { type: string; required?: boolean } }` — describes the configuration the host resolves into `ctx.config`. |
| `permissions`  | object, optional                                     | Access declarations (see below and [security-model.md](./security-model.md)).                                          |

### Kind rules (validated)

- `programmatic` and `mixed` **must** declare an `entrypoint`.
- `declarative` **must not** declare an `entrypoint`.

## `contributes`

Two flavors of keys:

**Declarative keys** hold _file paths_ relative to the extension directory.
Each key implies the expected declarative type, so the files may omit
`type:`:

| Key                 | Declarative type    |
| ------------------- | ------------------- |
| `methodologies`     | `methodology`       |
| `workflows`         | `workflow`          |
| `questionPacks`     | `question_pack`     |
| `promptTemplates`   | `prompt_template`   |
| `artifactTemplates` | `artifact_template` |
| `policyPresets`     | `policy_preset`     |
| `modelRouting`      | `model_routing`     |
| `reportTemplates`   | `report_template`   |
| `roleDefinitions`   | `role_definition`   |
| `commandMappings`   | `command_mapping`   |

**Programmatic keys** hold _contribution names_ that the compiled entrypoint
registers at runtime via the SDK:

| Key                       | Contribution kind                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `workItemProviders`       | `work_item_provider`                                                                |
| `communicationProviders`  | `communication_provider`                                                            |
| `modelProviders`          | `model_provider`                                                                    |
| `agentAdapters`           | `agent_adapter`                                                                     |
| `tools`                   | `tool`                                                                              |
| `contextSources`          | `context_source`                                                                    |
| `exporters`               | `exporter`                                                                          |
| `policyEvaluators`        | `policy_evaluator`                                                                  |
| `vcsProviders`            | `vcs_provider` (accepted for forward compatibility; activates in a later milestone) |
| `enterpriseSyncProviders` | `enterprise_sync_provider` (same)                                                   |

`communicationHandlers` is also accepted for forward compatibility but has no
contribution kind in M1.

## Example: declarative pack

```yaml
id: discovery-pack
name: Discovery Pack
version: 0.1.0
kind: declarative
description: Lightweight pre-work methodology for clarifying ideas before implementation.
contributes:
  methodologies:
    - ./methodologies/discovery.yaml
  workflows:
    - ./workflows/discovery.yaml
  questionPacks:
    - ./question-packs/product-discovery.yaml
    - ./question-packs/agent-readiness.yaml
  artifactTemplates:
    - ./artifacts/refined-ticket.md
  promptTemplates:
    - ./prompts/discovery-synthesis.md
  roleDefinitions:
    - ./roles/product-strategist.yaml
```

## Example: programmatic extension

```yaml
id: linear
name: Linear
version: 0.1.0
kind: programmatic
description: Linear work item provider for Excalibur.
entrypoint: dist/index.js
contributes:
  workItemProviders:
    - linear
capabilities:
  - work_items.read
  - work_items.comment
  - work_items.update_status
  - work_items.link_pr
configSchema:
  apiKeyEnv:
    type: string
    required: true
  workspace:
    type: string
    required: false
permissions:
  network:
    allowedHosts:
      - api.linear.app
```

Note `apiKeyEnv`: manifests carry environment variable **names**, never
secret values.

## `permissions`

Ten categories: `network`, `filesystem`, `process`, `secrets`, `git`,
`work_items`, `communication`, `models`, `tools`, `context`.

```yaml
permissions:
  network:
    allowedHosts: [api.linear.app]
  filesystem:
    read: ['.excalibur/**']
    write: ['.excalibur/runs/**']
  process:
    allowedCommands: [acme-agent]
  secrets:
    env: [LINEAR_API_KEY]
```

M1 validates declarations and emits warnings (wildcard hosts/commands,
writes outside `.excalibur/`, unknown categories, declarative extensions
declaring permissions, capabilities without permissions, suspicious
`secrets.env` names). Enforcement lands in M5. Details in
[security-model.md](./security-model.md).

## Validation

```bash
excalibur extensions validate    # all manifests + declarative files, exit 2 on invalid
excalibur extensions doctor      # load errors, missing entrypoints, permission warnings
```

Programmatically: `loadManifest(filePath)` (throws `ConfigValidationError`
with readable messages) and `validateManifest(value)` (returns
`{ success, data?, errors? }`), both from `@excalibur/extension-runtime`.
