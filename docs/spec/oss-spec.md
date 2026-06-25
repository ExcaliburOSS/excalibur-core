# Excalibur Core — Open-Source Technical Specification

> **Historical design spec.** This document defined the OSS architecture and
> drove Excalibur Core through milestones **M1–M3, which are now shipped**. The
> _interface and schema pins_ here remain binding, but the milestone-gated
> _behavioral_ notes ("M1 uses the mock provider", "real providers arrive in
> M2", "commands are simulated") describe the original phasing, not today's
> behavior — real model calls, real file mutation, real command execution,
> extension tool execution and opt-in permission enforcement all ship now. For
> the current shipped status see the [CHANGELOG](../../CHANGELOG.md); for the
> binding contract see [docs/CONTRACT.md](../CONTRACT.md).

Excalibur Core is a separate repository from Excalibur Enterprise, but tightly connected to it through shared schemas, workflow definitions, event formats, agent runtime interfaces, model provider adapters and configuration conventions.

The purpose of Excalibur Core is to become the open-source, local-first developer toolkit for AI-assisted and agentic software development.

Excalibur Enterprise builds on top of Excalibur Core and adds the enterprise control plane: web workbench, SSO, RBAC, audit logs, team management, cost governance, model governance, GitHub/GitLab App, hybrid runners, self-hosted deployment, compliance and collaboration.

Product naming:

- **Excalibur Core**: open-source local-first developer toolkit.
- **Excalibur Enterprise**: commercial enterprise workspace and governance platform.
- **Excalibur CLI**: command line interface, invoked as `excalibur`.
- **Excalibur Runner**: local/hybrid execution runner.
- **Excalibur Workbench**: enterprise web UI.
- **Excalibur Gateway**: model and tool gateway.
- **Excalibur Agent Runtime**: agent execution layer.

---

# 1. Strategic role of Excalibur Core

Excalibur Core must not be a weak community edition. It must be genuinely useful for individual developers and small teams.

Its role:

1. Let developers try Excalibur locally without enterprise setup.
2. Provide a flexible workflow system for AI-assisted and agentic development.
3. Support different levels of autonomy: review only, assist, propose patch, create branch, run local agentic workflow.
4. Provide a portable `.excalibur/` project configuration.
5. Provide a catalog of agentic development workflows and methodologies.
6. Allow developers to use their own models and agents.
7. Produce local artifacts and event logs compatible with Excalibur Enterprise.
8. Become the developer adoption wedge for the enterprise product.

Strategic split:

```text
Excalibur Core:
- Local-first. Developer-owned. CLI-first. Useful without cloud. Open-source.
- Single-user or small-team usage.
- Local workflows, local artifacts, local model configuration.

Excalibur Enterprise:
- Organization-first. Team collaboration. Governance. Web workbench.
- Centralized model control. Cost control. Audit logs. SSO/RBAC. Policies.
- Hybrid/self-hosted runners. Enterprise integrations.
```

Message:

> Excalibur Core makes individual developers productive with local AI-assisted and agentic workflows. Excalibur Enterprise makes it safe, observable and scalable for the whole company.

---

# 2. Repository structure

```text
excalibur-core/
  apps/
    cli/
      src/
        commands/
          init.ts ask.ts review.ts explain.ts patch.ts run.ts status.ts logs.ts
          apply.ts branch.ts pr.ts cmux.ts doctor.ts workflows.ts models.ts
  packages/
    core/
      src/
        autonomy/ workflows/ methodology/ runs/ config/ instructions/ context/
        git/ patches/ events/ artifacts/ telemetry/ errors/
    workflow-schema/
      src/
        schema.ts validator.ts default-workflows/ default-methodologies/ examples/
    agent-runtime/
      src/
        adapters/native/ adapters/custom-command/
        tools/  (read-file, write-file, list-files, search-code, run-command,
                 git-diff, apply-patch, create-branch, run-tests)
        sandbox/ permissions/ events/
    model-gateway/
      src/
        providers/ (openai-compatible, anthropic, ollama, vllm, custom)
        routing/ cost/ redaction/ types.ts
    context-engine/
      src/
        repo-scanner/ instruction-loader/ symbol-indexer/ code-search/
        stack-detector/ test-command-detector/ standards-generator/
    enterprise-sync/
      src/
        cloud-client.ts sync-events.ts auth.ts
    shared/
      src/
        types/ events/ artifacts/ config/ errors/ utils/
  examples/
    workflows/ methodologies/ instructions/ demo-repo/
  docs/
    getting-started.md configuration.md autonomy-levels.md workflows.md
    methodologies.md providers.md agents.md cmux.md enterprise-sync.md security.md
  package.json pnpm-workspace.yaml tsconfig.base.json README.md LICENSE
```

TypeScript + pnpm workspaces. License: **Apache 2.0** (adoption-friendly; enterprise value stays in the commercial layer).

NOTE (implementation decision): a `packages/work-items` package is added to this repo for the Work Item Integrations extension — see `docs/spec/work-items-core.md`.

---

# 3. CLI-first developer experience

CLI binary: `excalibur`.

Core commands:

```bash
excalibur init
excalibur ask "Where is escrow release implemented?"
excalibur explain src/escrow/escrow.service.ts
excalibur review --diff
excalibur review src/escrow/escrow.service.ts
excalibur patch "Fix duplicated escrow release on webhook retry"
excalibur run "Fix duplicated escrow release on webhook retry"
excalibur run "Implement contract renewal reminders" --careful
excalibur run "Explore approaches for contract versioning" --explore
excalibur status
excalibur logs
excalibur apply
excalibur branch
excalibur pr-summary
excalibur pr-create
excalibur workflows list
excalibur workflows explain standard-feature
excalibur models list
excalibur doctor
excalibur cmux
```

Three usage modes:

## 3.1 Lightweight assistant mode — creates an `AssistantInteraction`

`excalibur ask`, `excalibur explain`, `excalibur review --diff`. Does not modify files.

## 3.2 Patch mode — creates a `PatchRequest`

`excalibur patch "..."`. Generates a patch but does not apply it automatically. The user then chooses: `excalibur apply patch_123`, `excalibur branch patch_123`, `excalibur reject patch_123`.

## 3.3 Agentic run mode — creates a local `AgentRun`

`excalibur run "..." --level 3` / `--level 4`. Can create branches/worktrees, run tools, modify files, run tests and generate a PR summary.

---

# 4. `.excalibur/` project configuration

```text
.excalibur/
  config.yaml
  instructions/
    general.md architecture.md coding-style.md testing.md security.md
    database.md frontend.md backend.md domain.md
  workflows/
    review-only.yaml assist.yaml propose-patch.yaml fast-fix.yaml
    standard-feature.yaml structured-feature.yaml safe-refactor.yaml
    pr-review.yaml security-review.yaml migration.yaml explore-alternatives.yaml
  methodologies/
    lightweight.yaml spec-driven.yaml tdd-agentic.yaml review-first.yaml
    plan-then-execute.yaml explore-then-choose.yaml custom.yaml
  policies/
    permissions.yaml commands.yaml models.yaml sensitive-paths.yaml
  models/
    providers.yaml
  memory/
    decisions.md known-risks.md domain-glossary.md
  runs/
    # local runs created here
```

The `.excalibur/` directory should be human-readable, versionable in Git, optional but recommended, compatible with Excalibur Enterprise, editable by teams. The project must still work without `.excalibur/`, but `excalibur init` generates it.

---

# 5. `excalibur init`

1. Detect the repository.
2. Detect language and framework.
3. Detect package manager.
4. Detect test/lint/typecheck/build commands.
5. Detect existing AI instruction files: AGENTS.md, CLAUDE.md, Cursor rules, Copilot instructions, README, docs/architecture.md, ADRs.
6. Detect common patterns: backend/frontend split, test directory, API layer, database/migrations, domain modules, security-sensitive paths.
7. Generate `.excalibur/config.yaml`.
8. Generate default instructions.
9. Generate default workflows.
10. Generate default methodologies.
11. Ask user for confirmation before overwriting files.
12. Produce a summary of what was detected.

Example output:

```text
Detected:
- TypeScript - Node.js - NestJS - Prisma - PostgreSQL - Jest
- npm scripts: test: npm test / typecheck: npm run typecheck / lint: npm run lint

Generated:
- .excalibur/config.yaml
- .excalibur/instructions/testing.md
- .excalibur/workflows/fast-fix.yaml
- .excalibur/workflows/standard-feature.yaml
- .excalibur/methodologies/lightweight.yaml
```

---

# 6. Autonomy levels

Same levels as Enterprise (0 Review, 1 Assist, 2 Propose Patch, 3 Implement in Branch, 4 Full Agentic Workflow). The CLI exposes them through friendly commands, not numbers:

```bash
excalibur review --diff                                  # Level 0
excalibur ask "How does billing work?"                   # Level 1
excalibur patch "Fix missing validation"                 # Level 2
excalibur run "Fix webhook retry bug"                    # Level 3 by default
excalibur run "Implement contract renewal flow" --structured   # Level 4
```

Internal types still store `autonomyLevel`.

---

# 7. Catalog of agentic methodologies

Methodologies are templates/presets — never imposed. A methodology defines: philosophy, recommended autonomy level, typical phases, when to use / when not to use, required artifacts, recommended agent roles, recommended checks, approval behavior, risk profile, default workflow mapping.

Catalog (12):

| #    | id                  | Name                            | Autonomy | Typical flow                                                                                   |
| ---- | ------------------- | ------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| 7.1  | lightweight         | Lightweight Assistant           | 0–1      | Question/selection → AI response → developer decides                                           |
| 7.2  | review-first        | Review-First Development        | 0–2      | Developer writes code → AI reviews → developer fixes → PR                                      |
| 7.3  | patch-proposal      | Patch-Proposal Workflow         | 2        | Task → AI generates patch → human reviews → human applies                                      |
| 7.4  | fast-fix            | Fast Fix                        | 2–3      | Task → branch/worktree → AI patch → tests → summary                                            |
| 7.5  | plan-then-execute   | Plan-Then-Execute               | 3–4      | Task → short plan → implementation → tests → review                                            |
| 7.6  | spec-driven         | Spec-Driven Development         | 3–4      | Task → spec → plan → tasks → implementation → verification                                     |
| 7.7  | tdd-agentic         | Test-Driven Agentic Development | 2–4      | Task → reproduce/failing test → implementation → tests pass → review                           |
| 7.8  | safe-refactor       | Safe Refactor                   | 2–4      | Scope → invariants → baseline tests → refactor → tests → diff review                           |
| 7.9  | security-first      | Security-First Workflow         | 0–4      | Task → risk analysis → plan → implementation → security review → tests → human approval        |
| 7.10 | migration           | Migration Workflow              | 3–4      | Task → migration plan → backward compatibility check → implementation → rollback notes → tests |
| 7.11 | explore-then-choose | Explore Alternatives            | 3–4      | Task → alternative approaches → compare trade-offs → choose → implement                        |
| 7.12 | human-gated         | Human-Gated Agentic Workflow    | 3–4      | Task → plan → human approval → implementation → tests → human approval → PR                    |

Use-when guidance: 7.6 for ambiguous/customer-facing/complex/multi-module; 7.7 for bugs/regression prevention/critical business logic; 7.8 when no behavior change is intended; 7.9 for auth/payments/contracts/PII/permissions/secrets; 7.11 for complex decisions — present as "approach exploration", never "model comparison" (user-facing output: `Approach A — Minimal Change / Approach B — Clean Architecture / Approach C — Performance-Oriented`).

---

# 8. Methodology schema

Example definition:

```yaml
id: spec-driven
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
```

Definitions live in `packages/workflow-schema/src/default-methodologies/` and are copied into `.excalibur/methodologies/` on `excalibur init`.

---

# 9. Workflow catalog

A workflow is executable; a methodology is conceptual/prescriptive. Default workflows (12): `review-only, assist, propose-patch, fast-fix, standard-feature, structured-feature, safe-refactor, pr-review, security-review, migration, explore-alternatives, human-gated`.

Each workflow declares: supported autonomy levels, phases, whether it modifies files, whether it requires branch/worktree, whether it runs tests, whether it requires approval, expected artifacts.

Example `fast-fix.yaml`:

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
```

Example `structured-feature.yaml`:

```yaml
id: structured-feature
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
```

Example `explore-alternatives.yaml`:

```yaml
id: explore-alternatives
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
```

---

# 10. Granularity configuration

Granular configuration is central to the product.

## 10.1 Autonomy level — per command, workflow, repository, file path, task type, enterprise policy

```yaml
autonomy:
  default: 2
  paths:
    'src/billing/**': 1
    'src/auth/**': 1
    'src/contracts/signing/**': 2
  allowFullAgentic:
    - 'src/docs/**'
    - 'src/tests/**'
```

## 10.2 Workflow selection — per default, task type, path pattern

```yaml
workflows:
  default: standard-feature
  byTaskType:
    bugfix: fast-fix
    feature: standard-feature
    refactor: safe-refactor
    migration: migration
    security: security-review
  byPath:
    'src/billing/**': security-review
    'prisma/migrations/**': migration
```

## 10.3 Model routing — per default, task type, workflow, autonomy level, path sensitivity, phase, role

```yaml
models:
  default: qwen
  byRole:
    planner: qwen
    implementer: minimax
    reviewer: qwen
    security: local-secure
  byPath:
    'src/auth/**': local-secure
    'src/billing/**': local-secure
```

## 10.4 Tool permissions — per workflow, phase, role, path, command, autonomy level

```yaml
permissions:
  tools:
    read_file: true
    write_file: ask
    run_command: ask
    network: false
  blockedPaths:
    - '.env'
    - '**/*.pem'
    - '**/secrets/**'
  allowedCommands:
    - 'npm test'
    - 'npm run typecheck'
    - 'npm run lint'
```

## 10.5 Approval gates — per path, workflow, phase, task type, command, model, output type

```yaml
approvals:
  requiredFor:
    paths:
      - 'src/billing/**'
      - 'src/auth/**'
      - 'prisma/migrations/**'
    commands:
      - 'npm run migrate'
      - 'docker compose up'
    phases:
      - 'plan'
      - 'before_pr'
```

## 10.6 Context inclusion

```yaml
context:
  include:
    - instructions/general.md
    - instructions/architecture.md
    - instructions/testing.md
    - README.md
    - docs/**/*.md
  exclude:
    - '**/.env'
    - '**/node_modules/**'
    - '**/dist/**'
```

---

# 11. Local run artifact format

Every local run generates artifacts in `.excalibur/runs/<run-id>/`:

```text
.excalibur/runs/run_20260612_143022/
  run.json workflow.yaml methodology.yaml events.jsonl model-calls.jsonl
  input.md context.md diff.patch summary.md review.md
  test-results.json tests.log pr-summary.md artifacts/
```

`run.json` example:

```json
{
  "id": "run_20260612_143022",
  "title": "Fix duplicated escrow release",
  "autonomyLevel": 3,
  "workflow": "fast-fix",
  "methodology": "fast-fix",
  "status": "completed",
  "model": "qwen",
  "startedAt": "2026-06-12T14:30:22Z",
  "completedAt": "2026-06-12T14:34:10Z"
}
```

`events.jsonl` uses the same event format as Excalibur Enterprise (required so local OSS runs can later sync to Enterprise).

---

# 12. Event format compatibility

Shared event format example:

```json
{
  "id": "evt_123",
  "runId": "run_123",
  "type": "file_write",
  "timestamp": "2026-06-12T14:30:22Z",
  "payload": { "path": "src/escrow/escrow.service.ts", "operation": "modify" }
}
```

Event types (23): `run_started, run_completed, workflow_selected, methodology_selected, phase_started, phase_completed, assistant_message, model_call, tool_call, file_read, file_write, command_started, command_completed, test_result, patch_generated, patch_applied, branch_created, approval_requested, approval_approved, approval_rejected, policy_decision, error, artifact_created`.

Enterprise must be able to ingest these events. The canonical implementation is `packages/shared/src/events.ts`.

---

# 13. Enterprise sync hooks

Commands: `excalibur login`, `excalibur connect`, `excalibur sync`, `excalibur run "Fix bug" --sync`.

Behavior: without login everything stays local; with login, events/artifacts can sync to Enterprise, and Enterprise can provide allowed models, policies, team defaults, workflows, sensitive path rules, runner configuration. Sync must be optional and transparent.

```ts
interface EnterpriseSyncClient {
  pushRun(run: LocalRun): Promise<void>;
  pushEvent(event: ExcaliburEvent): Promise<void>;
  pullConfig(repositoryId?: string): Promise<EnterpriseConfig>;
}
```

---

# 14. Open-source model provider configuration

```yaml
providers:
  default: qwen
  qwen:
    type: openai-compatible
    baseUrl: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
    apiKeyEnv: QWEN_API_KEY
  minimax:
    type: openai-compatible
    baseUrl: https://api.minimax.io/v1
    apiKeyEnv: MINIMAX_API_KEY
  deepseek:
    type: openai-compatible
    baseUrl: https://api.deepseek.com/v1
    apiKeyEnv: DEEPSEEK_API_KEY
  local:
    type: openai-compatible
    baseUrl: http://localhost:8000/v1
    apiKeyEnv: LOCAL_MODEL_API_KEY
  ollama:
    type: ollama
    baseUrl: http://localhost:11434
```

Never store API keys in `.excalibur/` — environment variables only.

---

# 15. Agent adapter architecture

Initial adapters: `native`, `custom-command`. Future: claude-code, codex-cli, gemini-cli, aider, opencode, goose, cmux.

```ts
interface AgentAdapter {
  id: string;
  name: string;
  detect(): Promise<boolean>;
  run(input: AgentRunInput): AsyncIterable<ExcaliburEvent>;
}
```

`custom-command` adapter config example:

```yaml
agents:
  default: native
  claude-code:
    type: custom-command
    command: 'claude'
    args: ['--print', '{{prompt}}']
  aider:
    type: custom-command
    command: 'aider'
    args: ['--message', '{{prompt}}']
```

The native adapter uses the Excalibur Model Gateway and tools: `read_file, write_file, list_files, search_code, run_command, git_diff, apply_patch, create_branch, run_tests`.

---

# 16. CMUX integration (optional, later phase OSS-10)

`excalibur cmux run "Refactor billing service" --agents 3`. Detect if CMUX is installed; generate workspace/session config where possible; open panes (planner/implementer/reviewer/tests/logs); keep artifacts in `.excalibur/runs/`. CMUX is an interface, not a hard dependency — if not installed, show instructions.

---

# 17. Open-source security defaults

Defaults: do not read `.env`/private keys/PEM files; do not run dangerous commands without confirmation; ask before applying patches, writing files (unless workflow explicitly allows), creating branches, running commands not in allowlist; redact common secrets from prompts/logs.

Default blocked paths:

```text
.env  .env.*  **/*.pem  **/*.key  **/secrets/**  **/.ssh/**
node_modules/**  dist/**  build/**
```

Default allowed commands detected from package scripts: `npm test, npm run test, npm run typecheck, npm run lint, pnpm test, pnpm typecheck, pnpm lint, yarn test`.

---

# 18. Connection to Excalibur Enterprise

Enterprise consumes public packages: `@excalibur/core`, `@excalibur/workflow-schema`, `@excalibur/agent-runtime`, `@excalibur/model-gateway`, `@excalibur/shared` (plus `@excalibur/work-items`).

Shared between OSS and Enterprise: autonomy levels, workflow schema, methodology schema, event format, artifact format, model provider adapters, agent adapter interface, `.excalibur` config schema, local run format, instruction loader, context engine basics, patch format.

Enterprise adds: web workbench, organizations, teams, SSO/RBAC, policies, approvals, audit logs, cost dashboards, model governance, GitHub/GitLab App, hybrid runners, self-hosted deployment, compliance, collaboration.

---

# 19. Implementation phases for Excalibur Core

- **OSS-0 — Repository skeleton**: CLI app + core, workflow-schema, model-gateway, agent-runtime, context-engine, shared packages + docs + examples. No real model calls.
- **OSS-1 — Config and init**: `.excalibur/` config loader, `excalibur init`, stack/test-command/instruction-file detection, default workflow/methodology generation.
- **OSS-2 — Workflow and methodology schema**: schemas, validators, defaults, `excalibur workflows list|explain <id>`.
- **OSS-3 — Local artifacts and events**: run directory creation, run.json, events.jsonl, artifact writer, event writer, event types.
- **OSS-4 — Model gateway**: OpenAI-compatible/Ollama/vLLM/custom providers, env var keys, streaming, cost metadata, redaction.
- **OSS-5 — Lightweight assistant interactions**: ask/explain/review with model gateway + repo context.
- **OSS-6 — Patch generation**: patch, unified diff, artifact, summary, apply, branch.
- **OSS-7 — Native agent runtime**: NativeAgentAdapter, tool loop, the 9 tools, permission checks, confirmations.
- **OSS-8 — Local agentic runs**: run, workflow execution, phases, autonomy levels, execution styles, branch/worktree, test execution, summary.
- **OSS-9 — GitHub CLI support**: `pr-summary`, `pr-create` via `gh`.
- **OSS-10 — CMUX integration**.
- **OSS-11 — Enterprise sync hooks**: login/connect/sync (initially stubbed).

---

# 20. Implementation guidance

Do not build the entire enterprise product inside the open-source repo. Keep responsibilities clean (Core: local-first, CLI, workflows, methodologies, `.excalibur/`, local artifacts, model providers, native agent runtime, optional sync hooks; Enterprise: multi-tenant web product, collaboration, governance, policies, audit, cost, runners, SSO, GitHub/GitLab App).

Start with OSS-0 through OSS-3 before adding real model calls.

First useful demo: `excalibur init`, `excalibur workflows list`, `excalibur review --diff`, `excalibur patch "Fix duplicated webhook handling"`.
Second: `excalibur run "Fix duplicated webhook handling" --fast`.
Third: `excalibur run "Implement contract renewal reminders" --structured`.

The repo must be designed so Excalibur Enterprise can reuse the same workflow definitions, methodology definitions, event schema, artifact format, model gateway and agent runtime interfaces.
