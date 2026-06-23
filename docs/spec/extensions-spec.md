# Excalibur — Hybrid Extension Architecture Specification

Excalibur is an extensible runtime from the beginning. Core principle:

> Not every extension should require code. **YAML/Markdown defines how the team works. SDK code connects Excalibur to the outside world.**

Two kinds of extensions:

1. **Declarative extensions** — YAML, Markdown or JSON. No code. Safe, portable, Git-versionable, editable by tech leads. Types: `methodology, workflow, question_pack, prompt_template, artifact_template, policy_preset, model_routing, report_template, role_definition, command_mapping`.
2. **Programmatic extensions** — TypeScript Extension SDK. For external APIs, auth, webhooks, runtime behavior, agent tools, model providers, agent adapters, complex policy, custom context, exporters. Types: `work_item_provider, communication_provider, model_provider, agent_adapter, tool, context_source, exporter, policy_evaluator, vcs_provider, enterprise_sync_provider`.

Excalibur Core provides: Extension Runtime, Extension Registry, Extension Loader, Manifest Schema, Declarative Schemas, Programmatic SDK, Extension CLI commands, docs, examples. Excalibur Enterprise adds: admin UI, org/team/repo enablement, permissions, secrets/config management, version management, audit, policy.

---

## 1. Packages (in this repo)

- `packages/declarative-schemas` — zod schemas for the 10 declarative types (workflow/methodology re-exported from `@excalibur/workflow-schema`, which remains their owner) + a discriminated union on `type`.
- `packages/extension-runtime` — manifest (schema/loader/validator), `ExtensionRegistry` + `ContributionRegistry`, loaders (declarative from `.excalibur/**`, local programmatic, package), permission validation, `HookRegistry`, errors.
- `packages/extension-sdk` — `defineExtension`, `ExtensionContext`, contribution interfaces, hook types.
- `packages/built-in-extensions` — default catalogs packaged as declarative extension packs.

CLI additions: `excalibur extensions list|validate|install|enable|disable|doctor|create <type> <name>`.

Docs: `docs/extensions/*.md` (overview, declarative-extensions, programmatic-extensions, extension-manifest, creating-a-methodology, creating-a-workflow, creating-a-question-pack, creating-a-work-item-provider, creating-a-communication-provider, creating-a-tool, security-model, testing-extensions, publishing-extensions).

Examples: `examples/extensions/` — declarative-discovery-pack, declarative-safe-refactor, declarative-fast-fix-workflow, declarative-pr-summary-template, programmatic-custom-command-agent (+ more in later milestones).

---

## 2. `.excalibur/` additions

```text
.excalibur/
  config.yaml
  extensions.yaml
  methodologies/ workflows/ question-packs/ prompts/ artifacts/
  policies/ models/ (providers.yaml, routing.yaml) reports/ roles/ command-mappings/
  extensions/
    internal-tool/
      excalibur.extension.yaml
      package.json
      src/index.ts
```

`extensions.yaml`:

```yaml
enabled:
  - discovery-pack
  - fast-fix
  - github-issues
  - openai-compatible
  - native-agent
local:
  - ./extensions/internal-tool
declarative:
  - ./methodologies/discovery.yaml
  - ./workflows/fast-fix.yaml
  - ./question-packs/agent-readiness.yaml
```

---

## 3. Extension manifest (`excalibur.extension.yaml`)

```ts
type ExtensionManifest = {
  id: string;
  name: string;
  version: string;
  kind: 'declarative' | 'programmatic' | 'mixed';
  description?: string;
  entrypoint?: string; // programmatic/mixed
  contributes?: ExtensionContributions; // keys: methodologies, workflows, questionPacks,
  // promptTemplates, artifactTemplates, policyPresets,
  // modelRouting, reportTemplates, roleDefinitions,
  // commandMappings, workItemProviders, communicationProviders,
  // modelProviders, agentAdapters, tools, contextSources,
  // exporters, policyEvaluators, communicationHandlers
  capabilities?: string[]; // e.g. work_items.read, communication.post, reports.generate
  configSchema?: Record<string, { type: string; required?: boolean }>;
  permissions?: ExtensionPermissions;
};
```

Declarative pack example:

```yaml
id: discovery-pack
name: Discovery Pack
version: 0.1.0
kind: declarative
description: Lightweight pre-work methodology for clarifying ideas, tickets and feedback before implementation.
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
    - ./artifacts/mvp-scope.md
    - ./artifacts/readiness-assessment.md
  promptTemplates:
    - ./prompts/discovery-synthesis.md
  roleDefinitions:
    - ./roles/product-strategist.yaml
    - ./roles/scope-guardian.yaml
```

Programmatic example:

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

`kind: mixed` combines both (declarative contributions + entrypoint).

---

## 4. Declarative types (schemas)

- **methodology**: `{ id, type: 'methodology', name, category, description, recommendedAutonomyLevels?, useWhen?, avoidWhen?, defaultWorkflow?, workflows?, questions?, outputs?, roles?, scoring? }` (compatible superset of the existing methodology schema — `type` optional there).
- **workflow**: `{ id, type: 'workflow', name, mode, supportedAutonomyLevels?, phases }` (existing workflow schema + optional `type`).
- **question_pack**: `{ id, type: 'question_pack', name, questions: Array<{ id, text }> }`.
- **prompt_template**: YAML `{ id, type: 'prompt_template', name, template }` or Markdown file (id from filename).
- **artifact_template**: Markdown with `{{variable}}` placeholders (id from filename or YAML wrapper).
- **policy_preset**: `{ id, type: 'policy_preset', rules: Array<{ id, when: { filePathMatches?: string[], action?: string, command?: string }, decision: 'allow'|'deny'|'redact'|'require_approval' }> }`.
- **model_routing**: `{ id, type: 'model_routing', default?, byRole?, byPath?, byWorkflow? }`.
- **report_template**: `{ id, type: 'report_template', name, sections: string[] }`.
- **role_definition**: `{ id, type: 'role_definition', name, description }`.
- **command_mapping**: `{ id, type: 'command_mapping', commands: Array<{ trigger, action, defaults? }> }`.

---

## 5. Programmatic SDK

```ts
import { defineExtension } from '@excalibur-oss/extension-sdk';

export default defineExtension({
  id: 'linear',
  name: 'Linear',
  version: '0.1.0',
  register(ctx) {
    ctx.workItems.registerProvider(new LinearWorkItemProvider());
  },
});
```

```ts
type ExtensionContext = {
  methodologies: MethodologyRegistry;
  workflows: WorkflowRegistry;
  workItems: WorkItemProviderRegistry;
  communication: CommunicationProviderRegistry;
  models: ModelProviderRegistry;
  agents: AgentAdapterRegistry;
  tools: ToolRegistry;
  contextSources: ContextSourceRegistry;
  policies: PolicyRegistry;
  reports: ReportRegistry;
  exporters: ExporterRegistry;
  hooks: HookRegistry;
  logger: Logger;
  config: ExtensionConfig;
};
```

Contribution interfaces (reuse existing types where they exist — WorkItemProvider from `@excalibur/work-items`, ModelProviderAdapter from `@excalibur/model-gateway`, AgentAdapter from `@excalibur/agent-runtime`):

```ts
export interface CommunicationProvider {
  type: string;
  postMessage(input: PostMessageInput): Promise<PostMessageResult>;
  postThreadReply(input: PostThreadReplyInput): Promise<PostMessageResult>;
  getThreadReplies(input: GetThreadRepliesInput): Promise<ThreadReply[]>;
  validateCredentials(): Promise<boolean>;
}
// PostMessageInput { channelId, markdown, blocks? } · PostThreadReplyInput { channelId, threadId, markdown, blocks? }
// PostMessageResult { externalMessageId, threadId?, url? } · ThreadReply { externalMessageId, body, authorName?, createdAt? }

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: unknown; // JSON-schema-like
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}

export interface ContextSource {
  id: string;
  name: string;
  search(input: ContextSearchInput): Promise<ContextDocument[]>;
  load(input: ContextLoadInput): Promise<ContextDocument>;
}

export interface PolicyEvaluator {
  id: string;
  evaluate(context: PolicyContext): Promise<PolicyDecision>;
}

export interface ReportGenerator {
  id: string;
  generate(input: ReportInput): Promise<ReportOutput>;
}

export interface Exporter {
  id: string;
  export(input: ExportInput): Promise<ExportResult>;
}
```

---

## 6. Hooks

```ts
type ExcaliburHook =
  | 'workItem.received'
  | 'workItem.commandDetected'
  | 'discovery.started'
  | 'discovery.completed'
  | 'interaction.created'
  | 'patch.created'
  | 'run.created'
  | 'run.phaseStarted'
  | 'run.phaseCompleted'
  | 'run.completed'
  | 'run.failed'
  | 'pr.opened'
  | 'dailySummary.generating'
  | 'weeklyPlanning.started';

interface HookRegistry {
  on<TEvent>(hookName: string, handler: (event: TEvent) => Promise<void> | void): void;
  emit<TEvent>(hookName: string, event: TEvent): Promise<void>;
}
```

---

## 7. Loading and conflicts

Sources + order: 1) built-in extensions, 2) project declarative (`.excalibur/` files + `extensions.yaml` declarative list), 3) local programmatic (`.excalibur/extensions/*` with manifest + compiled entrypoint), 4) installed npm extensions (later milestone), 5) enterprise-managed (later milestone).

Conflicts: same id+version → ignore duplicate; same id different version → configured/latest compatible; same contribution id → project-level overrides built-in; enterprise can lock/disable overrides (later).

---

## 8. Permissions

Categories: `network, filesystem, process, secrets, git, work_items, communication, models, tools, context`.

```yaml
permissions:
  network:
    allowedHosts: [api.linear.app]
  filesystem:
    read: ['.excalibur/**']
    write: ['.excalibur/runs/**']
  secrets:
    env: [LINEAR_API_KEY]
```

M1: manifest validation must exist; enforcement is partial (validation + warnings). Enterprise enforces strictly later (M5).

---

## 9. CLI

```bash
excalibur extensions list          # all loaded extensions + contributions, source column
excalibur extensions validate      # validate manifests + declarative files, readable errors
excalibur extensions doctor        # diagnose load errors, missing entrypoints, permission issues
excalibur extensions enable <id> / disable <id>   # edits .excalibur/extensions.yaml
excalibur extensions install <path>               # local path → .excalibur/extensions/ (npm later)
excalibur extensions create methodology|workflow|question-pack|work-item-provider|communication-provider|tool <name>
```

Scaffolds: declarative → `extensions/<name>/` with manifest + YAML + README; programmatic → manifest + package.json + tsconfig + src/index.ts using defineExtension + README + test.

Demos (must work in M1): create methodology → validate → `methodologies list` shows it; create workflow safe-hotfix → `excalibur run "Fix webhook retry" --workflow safe-hotfix`; scaffold a programmatic provider and validate it.

---

## 10. OSS vs Enterprise

OSS must support: local declarative + local programmatic + built-ins, validation, scaffolding, local config/artifacts — with no enterprise registry/SSO/central admin/hosted secrets. Enterprise adds central management, permissions, secrets, team/repo enablement, audit, policy (DB: `ExtensionInstallation`, `ExtensionSecret`, `ExtensionAuditLog`).

## 11. Design rules

1. No SDK required for methodologies/workflows. 2. Don't hardcode integrations into core. 3. Declarative = safe + Git-versionable. 4. Programmatic = powerful but permissioned. 5. Same concepts in OSS and Enterprise. 6. Docs/examples first-class. 7. Everything works with zero custom extensions. 8. Built-ins use the same extension mechanisms where possible.
