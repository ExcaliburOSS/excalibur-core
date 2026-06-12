# Excalibur Core — Engineering Build Contract (M1)

This is the binding engineering contract for everyone (human or agent) building Excalibur Core in milestone M1. Read it fully, plus `docs/spec/oss-spec.md`, `docs/spec/work-items-core.md` and `docs/spec/agentic-agile-core.md`, before writing code. Where this contract pins an API, the pin wins over personal preference; if you believe a pin is wrong, implement it as pinned and flag the concern in your final report.

## 1. Scope of M1

OSS-0 → OSS-3 plus a fully working **mock loop**: `init`, `workflows list|explain`, `ask/explain/review`, `patch` lifecycle, `run` with local artifacts/events, `daily`/`weekly-plan` reports, the local **Discovery** flow (`excalibur discovery`, see `docs/spec/discovery-core.md`), and the **hybrid extension architecture** (EXT-0→EXT-4 + EXT-7 full; EXT-5 local-compiled-entrypoint only; EXT-8 manifest validation only — see `docs/spec/extensions-spec.md`). **No real model calls** (only `MockProvider`), **no real agent file modification**, **no real command execution inside runs** (commands are simulated with `simulated: true` payloads). Real providers/agents arrive in M2/M3.

## 2. Non-negotiable rules

1. Only modify files inside your assigned workspace (plus `examples/` or `docs/` if explicitly assigned).
2. Never edit any `package.json`, the lockfile, or root configs. Dependencies are pre-pinned. If something is genuinely missing, report it — do not install it.
3. Never run `pnpm add` / `pnpm install`. Build with `pnpm --filter ...<pkg> build` (the `...` prefix builds dependencies first), test with `pnpm --filter <pkg> test`, typecheck with `pnpm --filter <pkg> typecheck`.
4. The keystone files `packages/shared/src/{autonomy,enums,events,discovery}.ts` are **frozen**: import from them, never edit them.
5. TypeScript strict. No `any` (use `unknown` + narrowing). No `console.log` in packages — the CLI's `src/ui.ts` is the only place that prints.
6. All thrown errors are `ExcaliburError` subclasses (see §4.1).
7. Tests are colocated `*.test.ts` (vitest), and must be meaningful (behavior, not snapshots of trivia).
8. CommonJS-compatible code (no top-level await in packages). Node ≥ 22 APIs allowed.
9. Module style: every package has a single entry `src/index.ts` exporting the public API listed here. Internal structure is your call within the spec's directory hints.
10. Comments/docs in English. Keep code self-explanatory; comment only constraints.

## 3. Toolchain (pinned)

Node 24 (engines ≥22) · pnpm 9.12 · TypeScript ~5.8 · zod 3 · vitest 3 · tsup 8 (packages build dual CJS+ESM+dts) · commander 13 + picocolors (CLI) · yaml 2 · minimatch 10 · fast-glob 3.

Dependency graph (build order):

```text
shared → { workflow-schema, model-gateway, context-engine, work-items, enterprise-sync }
model-gateway → agent-runtime
workflow-schema → declarative-schemas → extension-runtime → built-in-extensions
{ model-gateway, agent-runtime, work-items, extension-runtime } → extension-sdk
{ shared, workflow-schema, model-gateway, agent-runtime, context-engine,
  extension-runtime, built-in-extensions, declarative-schemas } → core
all → cli
```

## 4. Pinned public APIs

Below, "pin" means: export exactly these names with these shapes (you may add extras, never rename/remove).

### 4.1 `@excalibur/shared`

Already on disk (frozen): `autonomy.ts` (AUTONOMY_LEVELS, autonomyLevelSchema, AutonomyLevel, AUTONOMY_LEVEL_LABELS, AUTONOMY_LEVEL_DESCRIPTIONS, isAutonomyLevel), `enums.ts` (executionStyleSchema/ExecutionStyle, outputTypeSchema/OutputType, runStatusSchema/RunStatus, phaseStatusSchema/PhaseStatus, agentRoleSchema/AgentRole — includes the six Discovery roles, workflowModeSchema/WorkflowMode — includes `discovery`, phaseTypeSchema/PhaseType — includes `discovery_questions`, testStatusSchema/TestStatus, riskLevelSchema/RiskLevel, policyDecisionSchema/PolicyDecisionValue), `events.ts` (excaliburEventTypeSchema/ExcaliburEventType, excaliburEventSchema/ExcaliburEvent, CreateEventInput, createEvent, serializeEventLine, parseEventsJsonl), `discovery.ts` (discoveryInputTypeSchema/Source/Recommendation/Score/agentReadiness schemas + types, AGENT_READINESS_TO_AUTONOMY, DiscoveryScores, DiscoveryAnswerEntry, discoveryRecordSchema/DiscoveryRecord, DISCOVERY_ARTIFACT_FILES, scoreDiscoveryTranscript, recommendFromScores).

Add:

- `errors.ts`: `class ExcaliburError extends Error { readonly code: string; readonly details?: Record<string, unknown> }` plus subclasses `ConfigValidationError`, `WorkflowValidationError`, `PermissionDeniedError`, `ProviderError`, `RunNotFoundError`, `CommandParseError` (each with a stable `code` like `'config_validation'`).
- `artifacts.ts`:
  - `runRecordSchema` / `RunRecord`: `{ id: string; title: string; autonomyLevel: AutonomyLevel; workflow: string; methodology: string | null; status: RunStatus; model: string | null; executionStyle: ExecutionStyle | null; startedAt: string (ISO); completedAt: string | null }` (superset of OSS spec §11 run.json — extra fields nullable).
  - `LocalRun`: `{ id: string; dir: string; record: RunRecord }`.
  - `RUN_ARTIFACT_FILES` const: `run.json, workflow.yaml, methodology.yaml, events.jsonl, model-calls.jsonl, input.md, context.md, diff.patch, summary.md, review.md, test-results.json, tests.log, pr-summary.md`.
- `config.ts`: `excaliburConfigSchema` / `ExcaliburConfig` modeling OSS spec §10 + §14 + work-items §6, all sections optional:
  `project?: { name?: string; commands?: { test?: string; lint?: string; typecheck?: string; build?: string } }`,
  `autonomy?: { default?: AutonomyLevel; paths?: Record<string, AutonomyLevel>; allowFullAgentic?: string[] }`,
  `workflows?: { default?: string; byTaskType?: Record<string, string>; byPath?: Record<string, string> }`,
  `models?: { default?: string; byRole?: Record<string, string>; byPath?: Record<string, string> }`,
  `permissions?: { tools?: Record<string, boolean | 'ask'>; blockedPaths?: string[]; allowedCommands?: string[] }`,
  `approvals?: { requiredFor?: { paths?: string[]; commands?: string[]; phases?: string[] } }`,
  `context?: { include?: string[]; exclude?: string[] }`,
  `integrations?: Record<string, Record<string, string>>`,
  `agents?: { default?: string } & Record<string, unknown>`,
  `instructions?: { sources?: Array<{ path: string; format?: InstructionSourceFormat; scope?: InstructionSourceScope; enabled?: boolean; localOnly?: boolean }> }`,
  `skills?: { sources?: Array<{ path: string; scope?: 'project'|'user_global'; enabled?: boolean; trustLevel?: TrustLevel }> }`.
  Also `DEFAULT_BLOCKED_PATHS` (OSS §17 list), `DEFAULT_ALLOWED_COMMANDS` (OSS §17 list), `DEFAULT_CONFIG: ExcaliburConfig`.
- `ids.ts`: `generateRunId(date?: Date): string` → `run_YYYYMMDD_HHMMSS` local time; `generateId(prefix: string): string` → `<prefix>_<uuid>`.
- `instructions.ts`: the exact ISD types from `docs/spec/instructions-skills-core.md` §2 — `InstructionSourceScope/Format/Kind`, `TrustLevel`, `InstructionSource`, `DetectedSkill` (+ zod schemas `instructionSourceSchema`, `detectedSkillSchema`) and `DEFAULT_TRUST_RULES` (the trust-default table of §3 as data: `Array<{ format; scope; trustLevel; kind }>`).
- `index.ts` re-exporting everything.

### 4.2 `@excalibur/workflow-schema`

- `workflowPhaseSchema` / `WorkflowPhase`: `{ id, name, type: PhaseType, role?: AgentRole, required?: boolean (default true), optional?: boolean, agents?: number, worktree?: boolean, modifiesFiles?: boolean, commands?: string[], commandsFromConfig?: boolean, output?: string, approval?: 'required'|'optional'|'none', requiresHumanConfirmation?: boolean, onFailure?: 'abort'|'continue'|'retry' (default 'abort'), maxRetries?: number }`. Validator normalizes `optional: true` → `required: false`.
- `workflowDefinitionSchema` / `WorkflowDefinition`: `{ id, type?: 'workflow' (optional discriminator for declarative files), name, description?, mode: WorkflowMode, supportedAutonomyLevels?: AutonomyLevel[] (default [0,1,2,3,4]), inputs?: string[], defaults?: { model?: string; commands?: string[] }, phases: WorkflowPhase[] (min 1) }`.
- `methodologySchema` / `Methodology`: `{ id, type?: 'methodology' (optional discriminator), name, description, category?: string (default 'delivery'), recommendedAutonomyLevels?: AutonomyLevel[], useWhen?: string[], avoidWhen?: string[], defaultWorkflow?: string, workflows?: string[], phases?: string[], artifacts?: string[], outputs?: string[], modes?: string[], questions?: Array<{ id: string; text: string }>, agentRoles?: AgentRole[], roles?: string[], approval?: Record<string, 'required'|'optional'|'recommended'|'none'>, riskProfile?: 'low'|'medium'|'high' (default 'medium'), scoring?: unknown }`. The 13 built-in methodology YAMLs keep all the richer fields populated.
- `parseWorkflowYaml(yamlText: string): WorkflowDefinition` and `parseMethodologyYaml(yamlText: string): Methodology` — throw `WorkflowValidationError` with human-readable messages (path + problem).
- `validateWorkflowDefinition(value: unknown): { success: boolean; data?: WorkflowDefinition; errors?: string[] }` (same for `validateMethodology`).
- `DEFAULT_WORKFLOWS: ReadonlyArray<{ id: string; yaml: string; definition: WorkflowDefinition }>` — the **13** workflows: `review-only, assist, propose-patch, fast-fix, standard-feature, structured-feature, safe-refactor, pr-review, security-review, migration, explore-alternatives, human-gated, discovery`. The three YAML examples in oss-spec §9 are verbatim-normative, as is `discovery.yaml` in `docs/spec/discovery-core.md` §5; author the other eight in the same style (review-only/assist/propose-patch follow the Enterprise spec §8 examples; `human-gated` = plan → human_approval(required) → agent_work → command_group → human_approval(required) → pull_request).
- `DEFAULT_METHODOLOGIES: ReadonlyArray<{ id: string; yaml: string; definition: Methodology }>` — the **13** methodologies: the 12 of oss-spec §7 (ids in the table) plus `discovery` (verbatim-normative YAML in `docs/spec/discovery-core.md` §4); `spec-driven` YAML in oss-spec §8 is verbatim-normative.
- `DISCOVERY_QUESTION_PACKS: Record<DiscoveryInputType, ReadonlyArray<{ id: string; text: string }>>` — packs from `docs/spec/discovery-core.md` §2 (`incident`, `mvp_scope`, `other` reuse the base pack; `work_item` uses the existing-ticket pack; `idea` the product-idea pack).
- `getDefaultWorkflow(id): WorkflowDefinition | undefined`, `getDefaultMethodology(id)`.
- YAML sources are embedded as TS string constants (so the built package needs no file resolution) AND mirrored as real files in `default-workflows/`/`default-methodologies/` at the package root; a test asserts embedded strings match the files.

### 4.3 `@excalibur/model-gateway`

- Types: `ChatMessage { role: 'system'|'user'|'assistant'; content: string }`, `ChatInput { model?: string; messages: ChatMessage[]; temperature?: number; maxTokens?: number; metadata?: Record<string, unknown> }`, `ChatOutput { content: string; model: string; usage: { inputTokens: number; outputTokens: number }; costCents: number | null; finishReason: 'stop'|'length'|'error' }`, `ChatDelta { content: string; done: boolean }`.
- `interface ModelProviderAdapter { readonly name: string; chat(input: ChatInput): Promise<ChatOutput>; stream(input: ChatInput): AsyncIterable<ChatDelta>; }`
- `providersFileSchema` / `ProvidersFileConfig` for `.excalibur/models/providers.yaml` (oss-spec §14): `{ providers: { default?: string } & Record<string, { type: 'openai-compatible'|'anthropic'|'ollama'|'vllm'|'custom'|'mock'; baseUrl?: string; apiKeyEnv?: string; model?: string; inputCostPerMillionTokensCents?: number; outputCostPerMillionTokensCents?: number }> }`.
- `loadProvidersFile(filePath: string): ProvidersFileConfig` (throws ConfigValidationError) and `DEFAULT_PROVIDERS_CONFIG` (single `mock` provider as default).
- `resolveApiKey(cfg): string | null` — reads `process.env[cfg.apiKeyEnv]`; never logs the value.
- `class MockProvider implements ModelProviderAdapter` — deterministic, see §7.
- `createProvider(name, cfg): ModelProviderAdapter` — `mock` → MockProvider; any other type → an adapter whose methods throw `ProviderError` with code `provider_not_implemented` and message "real providers arrive in OSS-4 (M2)".
- `class ModelGateway { constructor(cfg: ProvidersFileConfig); chat(input: ChatInput & { provider?: string }): Promise<ChatOutput>; stream(...): AsyncIterable<ChatDelta>; }` — resolves provider by name or default; computes `costCents` via `computeCostCents`.
- `estimateTokens(text: string): number` = `Math.ceil(text.length / 4)`; `computeCostCents(usage, cfg): number | null`.
- `redactSecrets(text: string): string` — masks with `[REDACTED]`: OpenAI-style `sk-…`, AWS `AKIA…`, GitHub `ghp_/gho_/ghs_…`, Slack `xox…`, `-----BEGIN … PRIVATE KEY-----` blocks, `Authorization: Bearer …`, `password=…`/`apiKey: …` values. Unit-tested with real-shaped fixtures.

### 4.4 `@excalibur/agent-runtime`

- `interface AgentAdapter { id: string; name: string; capabilities: string[]; detect(): Promise<boolean>; run(input: AgentRunInput): AsyncIterable<ExcaliburEvent>; stop?(sessionId: string): Promise<void>; }`
- `AgentRunInput { runId: string; sessionId: string; workdir: string; prompt: string; role: AgentRole; model?: string; phase?: { id: string; name: string; type: PhaseType }; config: ExcaliburConfig; gateway: ModelGateway }`.
- `NATIVE_TOOLS: ReadonlyArray<NativeToolDefinition>` where `NativeToolDefinition { name: 'read_file'|'write_file'|'list_files'|'search_code'|'run_command'|'git_diff'|'apply_patch'|'create_branch'|'run_tests'; description: string; parameters: z.ZodTypeAny }`.
- `type PermissionDecision = { allowed: boolean; requiresConfirmation: boolean; reason: string }`.
- `class PermissionEngine { constructor(permissions?: ExcaliburConfig['permissions']); checkPath(relPath: string, op: 'read'|'write'): PermissionDecision; checkCommand(command: string): PermissionDecision; }` — minimatch (`dot: true`) against blockedPaths (defaults from shared `DEFAULT_BLOCKED_PATHS`) and allowedCommands; tool flags `true`→allowed, `'ask'`→requiresConfirmation, `false`→denied.
- `class NativeAgentAdapter implements AgentAdapter` — M1 behavior: uses the gateway's MockProvider to produce a scripted, realistic event stream for the phase (tool_call → file_read → model_call → file_write → command_started/completed `{ simulated: true }` → test_result passed → patch_generated when role is implementer), **never touches the user's filesystem**; the generated mock diff travels in the `patch_generated` payload as `{ diff: string, filesAffected: string[] }`.
- `class CustomCommandAdapter implements AgentAdapter` — config shape per oss-spec §15; `detect()` checks the binary exists on PATH; `run()` yields a single `error` event explaining it activates in M3.

### 4.5 `@excalibur/context-engine`

- `RepoAnalysis { root: string; languages: string[]; frameworks: string[]; packageManager: 'npm'|'pnpm'|'yarn'|'bun'|null; commands: { test?: string; lint?: string; typecheck?: string; build?: string }; instructionFiles: Array<{ path: string; kind: 'agents_md'|'claude_md'|'cursor_rules'|'copilot_instructions'|'readme'|'architecture_doc'|'adr'|'other' }>; patterns: { hasBackend: boolean; hasFrontend: boolean; testDirs: string[]; migrationDirs: string[]; apiDirs: string[]; domainDirs: string[]; sensitivePaths: string[] }; suggestedWorkflows: string[] }`.
- `analyzeRepository(dir: string): Promise<RepoAnalysis>` plus granular `detectStack(dir)`, `detectCommands(dir)`, `detectInstructionFiles(dir)`, `detectPatterns(dir)`.
- ISD scanner (`docs/spec/instructions-skills-core.md` §1–§3): `scanInstructionSources(input: { repoRoot: string; homeDir?: string; includeUserGlobal?: boolean }): Promise<InstructionSource[]>` (classification + trust via DEFAULT_TRUST_RULES; contentHash = sha256; ids stable like `claude-project`, `skill-<dirname>`), `detectSkills(input): Promise<DetectedSkill[]>` with `parseSkillMd(content, path)` extracting name/description/triggers/dependencies/toolsRequired (null/empty when unparseable). `RepoAnalysis` gains `instructionSources: InstructionSource[]` and `skills: DetectedSkill[]` (homeDir scanning off by default in `analyzeRepository`, on in CLI). Tests must cover every format with fixtures, trust defaults, user-global separation, SKILL.md parse fallbacks.
- Detection sources: package.json (deps → frameworks: nestjs, nuxt, vue, react, next, express, fastify, prisma…; scripts → commands), lockfiles → packageManager, tsconfig/pyproject/go.mod/Cargo.toml → languages, dirs (`prisma/migrations`, `test|tests|__tests__|spec`, `src/api|routes|controllers`), sensitive paths (auth/billing/payments/secrets dirs + `.env*`).
- Owns `examples/demo-repo/`: a minimal fake NestJS+Prisma project (package.json with test/lint/typecheck scripts, `src/escrow/escrow.service.ts` containing a plausible duplicate-release bug, `src/contracts/`, `prisma/schema.prisma`, README, AGENTS.md) used by its own fixtures-based tests and by the CLI demo.

### 4.6 `@excalibur/core`

- Config: `loadExcaliburConfig(repoRoot: string): { config: ExcaliburConfig; source: 'file'|'defaults'; path?: string }` (reads `.excalibur/config.yaml`, validates, merges over `DEFAULT_CONFIG`); `EXCALIBUR_DIR = '.excalibur'`.
- Extensions integration: `createExtensionHost(repoRoot): Promise<ExtensionRegistry>` = `loadExtensions({ repoRoot, builtIns: BUILT_IN_EXTENSIONS })`. The workflow/methodology **catalog used by selectWorkflow, init and the CLI comes from `registry.contributions`** (workflows()/methodologies()), so project-level declarative files override built-ins with zero special-casing. `selectWorkflow` keeps its pinned signature (`catalog` param).
- Init: `generateInitPlan(analysis: RepoAnalysis): InitPlan` where `InitPlan { files: Array<{ relPath: string; content: string; exists: boolean }>; summaryLines: string[] }` — generates config.yaml (with detected commands), `extensions.yaml` (enabled: built-in pack ids), instruction stubs informed by the analysis, all 13 default workflow YAMLs, all 13 methodology YAMLs, `models/providers.yaml` (mock default + commented real examples), `policies/*.yaml`, `memory/*.md` stubs. `applyInitPlan(repoRoot, plan, opts: { overwrite: boolean }): { written: string[]; skipped: string[] }`.
- Runs: `class RunManager { constructor(repoRoot: string); createRun(input: { title: string; autonomyLevel: AutonomyLevel; workflow: string; methodology?: string | null; model?: string | null; executionStyle?: ExecutionStyle | null }): LocalRun; appendEvent(runId: string, event: ExcaliburEvent): void; writeArtifact(runId: string, fileName: string, content: string): string; updateRecord(runId: string, patch: Partial<RunRecord>): RunRecord; getRun(runId: string): LocalRun; listRuns(): LocalRun[]; latestRun(): LocalRun | null; readEvents(runId: string): ExcaliburEvent[]; }` — throws `RunNotFoundError` when missing; `events.jsonl` lines via `serializeEventLine`.
- Selection: `selectWorkflow(input: { config: ExcaliburConfig; catalog: ReadonlyArray<{ id: string; definition: WorkflowDefinition }>; autonomyLevel: AutonomyLevel; executionStyle: ExecutionStyle; taskType?: string; paths?: string[]; explicitWorkflow?: string }): { workflowId: string; definition: WorkflowDefinition; reason: string }` with priority: explicit > config.workflows.byPath match > level/style mapping table:
  L0→`review-only` (taskType `security`→`security-review`); L1→`assist`; L2→`propose-patch` (taskType `refactor`→`safe-refactor`); L3: fast→`fast-fix`, structured→`structured-feature`, explore→`explore-alternatives`, careful→`standard-feature`, team_default→config byTaskType/taskType ?? config default ?? `standard-feature`; L4: explore→`explore-alternatives`, careful→`human-gated`, otherwise→`structured-feature`. Falls back to `standard-feature` and explains in `reason`.
- Engine: `executeLocalRun(input: { repoRoot: string; runManager: RunManager; run: LocalRun; definition: WorkflowDefinition; gateway: ModelGateway; adapter: AgentAdapter; config: ExcaliburConfig; confirm?: (question: string) => Promise<boolean>; onEvent?: (e: ExcaliburEvent) => void }): Promise<RunRecord>` — sequential phases; per phase emits `phase_started`/`phase_completed`; behavior per type in M1: `assistant_interaction|agent_output|agent_review` → gateway chat (mock) → artifact (`output` filename or `<phaseId>.md`) + `assistant_message`+`model_call` events; `patch_generation` → mock diff → `diff.patch` + `patch_generated`; `agent_work` → consume `adapter.run()` and forward events, collect diff from `patch_generated` payload; `command_group` → for each command emit `command_started`/`command_completed` with `{ command, simulated: true, exitCode: 0 }` + one `test_result` `{ status: 'passed', simulated: true }` and write `test-results.json`; `human_approval` → `approval_requested`, then `confirm()` (auto-approve `{ auto: true }` when no confirm fn) → `approval_approved` or, if denied and phase required, run `status: 'cancelled'`; `apply_patch` → confirm → `patch_applied { simulated: true }`; `pull_request` → write `pr-summary.md` + `artifact_created`. First events of every run: `run_started`, `workflow_selected`, optional `methodology_selected`; last: `run_completed` (status reflected in run.json). On error: `error` event + status `failed`.
- Git helpers (real, via child_process): `getGitInfo(repoRoot): { isRepo: boolean; branch: string | null; remoteUrl: string | null }`, `getLocalDiff(repoRoot): string`, `createBranch(repoRoot, name): void`, `listRecentCommits(repoRoot, sinceIso): Array<{ hash: string; subject: string; author: string; date: string }>`.
- Reports (AA-8): `generateDailyReport(input: { repoRoot: string; runManager: RunManager; now?: Date }): string` (markdown: completed/failed runs, patches, recent commits, pending items) and `generateWeeklyPlan(input)`; `writeReport(repoRoot, fileName, markdown): string` into `.excalibur/reports/` (names `daily-YYYY-MM-DD.md`, `weekly-plan-YYYY-Www.md`).
- ISD (ISD-2/4/5, `docs/spec/instructions-skills-core.md` §5–§9): `class EffectiveInstructionBuilder { constructor(deps: { repoRoot: string }); build(input: { repositoryPath: string; workflowId?: string; autonomyLevel?: number; includeUserGlobal?: boolean; enabledSkills?: string[] }): Promise<{ instructionsMarkdown: string; sources: InstructionSource[]; warnings: string[] }> }` — precedence §4, per-source headers, dedupe by contentHash, redactSecrets on content, disabled/review_required skills excluded, conflict warnings (package-manager conflict check vs detected commands at minimum), per-source cap 4000 chars / total 24000 with `…summarized` marker. `generateInitPlan` consumes `analysis.instructionSources`/`analysis.skills`: prints the grouped detection report lines, writes `instructions.sources`/`skills.sources` references into config.yaml (user-global entries get `localOnly: true`; skills enabled: false when review_required), never copies user-global files. `executeLocalRun` and `DiscoveryManager.completeSession` prepend `instructionsMarkdown` to gateway prompts and emit a `log` event with `{ instructionSources: string[], instructionWarnings: string[] }`.
- Discovery (D-7): `class DiscoveryManager { constructor(repoRoot: string); createSession(input: { title: string; inputType: DiscoveryInputType; source: DiscoverySource; inputMarkdown: string }): { id: string; dir: string; record: DiscoveryRecord }; recordAnswer(id: string, entry: DiscoveryAnswerEntry): void; completeSession(id: string, gateway: ModelGateway): Promise<DiscoveryRecord>; getSession(id: string); listSessions(); }` — sessions live in `.excalibur/discovery/<id>/` (id `disc_YYYYMMDD_HHMMSS`); `completeSession` scores with `scoreDiscoveryTranscript`, recommends with `recommendFromScores`, writes all `DISCOVERY_ARTIFACT_FILES` (synthesis text via MockProvider with `metadata.kind` `'summary'|'plan'`, scores/recommendation rendered deterministically), updates `discovery.json`.

### 4.6b `@excalibur/declarative-schemas`

Schemas for the 10 declarative extension types per `docs/spec/extensions-spec.md` §4. Pins: `questionPackSchema/QuestionPackDefinition`, `promptTemplateSchema/PromptTemplateDefinition`, `artifactTemplateSchema/ArtifactTemplateDefinition` (`{ id, type: 'artifact_template', name?, template: string, variables: string[] }` — variables auto-extracted from `{{...}}`), `policyPresetSchema/PolicyPresetDefinition`, `modelRoutingSchema/ModelRoutingDefinition`, `reportTemplateSchema/ReportTemplateDefinition`, `roleDefinitionSchema/RoleDefinition`, `commandMappingSchema/CommandMappingDefinition`; re-exports `workflowDefinitionSchema`/`methodologySchema` from `@excalibur/workflow-schema`; `declarativeDefinitionSchema` = discriminated union on `type`; `parseDeclarativeYaml(text, expectedType?)` and `parseDeclarativeMarkdown(filePath, content)` (markdown → prompt_template or artifact_template by directory hint or front-matter `type`); `DECLARATIVE_TYPES` const array.

### 4.6c `@excalibur/extension-runtime`

Per `docs/spec/extensions-spec.md` §3, §7, §8 and §6 (hooks). Pins:

- `extensionManifestSchema` / `ExtensionManifest` (exact fields in the spec doc §3, incl. `permissions` with categories `network/filesystem/process/secrets/git/work_items/communication/models/tools/context`); `loadManifest(filePath)`, `validateManifest(value): { success; data?; errors?: string[] }`.
- `extensionsFileSchema` / `ExtensionsFileConfig` for `.excalibur/extensions.yaml` (`enabled?: string[], disabled?: string[], local?: string[], declarative?: string[]`); `loadExtensionsFile(repoRoot)`.
- `type Contribution = { kind: <one of the 10 declarative types or 10 programmatic types>; id: string; extensionId: string; source: 'built_in'|'project'|'local'|'npm'|'enterprise'; definition?: unknown; value?: unknown }`.
- `class ContributionRegistry { register(c: Contribution): void; get(kind, id): Contribution | undefined; list(kind?): Contribution[]; workflows(): WorkflowDefinition[]; methodologies(): Methodology[] }` — conflict rules per spec §7 (project overrides built_in for the same contribution id; duplicate id+source ignored with a recorded warning; `warnings(): string[]`).
- `class ExtensionRegistry { extensions(): LoadedExtension[]; contributions: ContributionRegistry; hooks: HookRegistry }` where `LoadedExtension = { manifest: ExtensionManifest; source; dir: string | null; status: 'loaded'|'error'; error?: string }`.
- `loadExtensions(input: { repoRoot: string; builtIns: ReadonlyArray<BuiltInExtensionPack> }): Promise<ExtensionRegistry>` — order: built-ins → project declarative files (scan `.excalibur/{methodologies,workflows,question-packs,prompts,artifacts,policies,models,reports,roles,command-mappings}` + `extensions.yaml` `declarative:` list) → local programmatic (`extensions.yaml` `local:` dirs and `.excalibur/extensions/*` with a manifest; `require(entrypoint)` of compiled JS only, errors recorded not thrown) → respects `enabled`/`disabled`.
- `class HookRegistry` with `on/emit` per spec §6; emit awaits handlers sequentially, isolates handler errors (collects, never throws).
- `validatePermissions(manifest): string[]` (warnings; enforcement comes in M5).

### 4.6d `@excalibur/extension-sdk`

Per spec doc §5. Pins: `defineExtension(def: { id; name; version; description?; register(ctx: ExtensionContext): void | Promise<void> }): ExcaliburExtension`; `ExtensionContext` with the 12 registries + `logger` (`{ info/warn/error(msg: string): void }`) + `config: Record<string, unknown>`; registries are thin typed wrappers over `ContributionRegistry.register` (e.g. `ctx.workItems.registerProvider(p: WorkItemProvider)`, `ctx.models.registerProvider(p: ModelProviderAdapter)`, `ctx.agents.registerAdapter(a: AgentAdapter)`, `ctx.tools.registerTool(t: AgentTool)` …). New interfaces owned here: `CommunicationProvider` (+ PostMessageInput/PostThreadReplyInput/PostMessageResult/ThreadReply), `AgentTool`/`ToolContext`/`ToolResult`, `ContextSource`/`ContextSearchInput`/`ContextLoadInput`/`ContextDocument`, `PolicyEvaluator`/`PolicyContext`/`PolicyDecision` (reuse policyDecisionSchema from shared for the decision value), `ReportGenerator`, `Exporter`. Reused interfaces: `WorkItemProvider` (@excalibur/work-items), `ModelProviderAdapter` (@excalibur/model-gateway), `AgentAdapter` (@excalibur/agent-runtime).

### 4.6e `@excalibur/built-in-extensions`

Pins: `BUILT_IN_EXTENSIONS: ReadonlyArray<BuiltInExtensionPack>` where `BuiltInExtensionPack = { manifest: ExtensionManifest; contributions: Contribution[] }`. Packs: `core-methodologies` (13 methodologies), `core-workflows` (13 workflows), `discovery-pack` (question packs from DISCOVERY_QUESTION_PACKS + discovery roles as role_definitions + artifact templates refined-ticket/mvp-scope/readiness-assessment + prompt discovery-synthesis), `core-prompts` (pr-summary, code-review), `core-policies` (safe-defaults preset from DEFAULT_BLOCKED_PATHS), `core-reports` (daily-summary, weekly-plan report templates), `core-command-mappings` (work-item-commands mapping mirroring the parser table). All content sourced from `@excalibur/workflow-schema` constants where they exist (single source of truth — packs wrap, never duplicate). A test validates every pack against `extensionManifestSchema` and every contribution against its declarative schema.

### 4.7 `@excalibur/work-items`

Everything in `docs/spec/work-items-core.md`, plus pins:

- zod schemas (`normalizedWorkItemSchema`, etc.) alongside the TS types with the exact spec names.
- `EXCALIBUR_COMMANDS` const; `ParsedExcaliburCommand { command: string; subcommand?: string; args: string[]; flags: Record<string, string | boolean>; raw: string }`; `parseExcaliburCommand(text: string): ParsedExcaliburCommand | null` — finds the first `@excalibur <command>` mention anywhere in a comment (case-insensitive mention), parses `--flag value` and bare `--flag`; unknown command → throws `CommandParseError`; no mention → `null`.
- `commandToAction(parsed: ParsedExcaliburCommand): WorkItemCommandAction` where `WorkItemCommandAction = { kind: 'interaction'; interactionType: 'work_item_refinement'|'work_item_plan'|'work_item_review'; autonomyLevel: 0 } | { kind: 'patch'; autonomyLevel: 2; variant: 'suggest_patch'|'generate_tests' } | { kind: 'run'; autonomyLevel: 3|4; executionStyle: ExecutionStyle } | { kind: 'status' } | { kind: 'cancel' } | { kind: 'daily' } | { kind: 'planning'; action: string; args: string[] } | { kind: 'discovery'; action?: string; args: string[] }` following the mapping table in the spec doc. Discovery-related commands: `discovery` (optional subcommands `complete|create-linear|update-ticket|create-run|save-decision`), `readiness`, `acceptance-criteria`, `split-scope` → all `{ kind: 'discovery', action: <command or subcommand> }`; `refine` keeps its interaction mapping.
- `CommentTemplateName = 'run_started'|'plan_generated'|'patch_suggested'|'pr_opened'|'run_failed'|'need_repository'|'identity_not_verified'`; `renderCommentTemplate(name, vars: Record<string, string>): string` — throws `CommandParseError`-style error (`ExcaliburError`, code `template_missing_variable`) on missing variables.
- `class MockWorkItemProvider implements WorkItemProvider { constructor(type: WorkItemProviderType, seed?: NormalizedWorkItem[]) }` — deterministic in-memory items (default seed: 3 plausible items keyed `DEMO-1..3`), records comments/status updates/links in memory for test assertions.

### 4.8 `@excalibur/enterprise-sync`

- `EnterpriseConfig { allowedModels?: string[]; workflows?: unknown[]; policies?: unknown[]; teamDefaults?: Record<string, unknown>; sensitivePaths?: string[] }`.
- `interface EnterpriseSyncClient { pushRun(run: LocalRun): Promise<void>; pushEvent(event: ExcaliburEvent): Promise<void>; pullConfig(repositoryId?: string): Promise<EnterpriseConfig>; }`
- `class HttpEnterpriseSyncClient implements EnterpriseSyncClient { constructor(opts: { baseUrl: string; apiKey: string }) }` — `fetch` against `POST {base}/api/sync/runs`, `POST {base}/api/sync/events`, `GET {base}/api/sync/config`; treat non-2xx as `ProviderError` code `sync_failed`. Experimental in M1.
- Credentials helpers: `loadCliCredentials() / saveCliCredentials({ baseUrl, apiKey })` at `~/.config/excalibur/credentials.json`, file mode 0600, `EXCALIBUR_API_KEY`/`EXCALIBUR_BASE_URL` env vars take precedence.

### 4.9 `@excalibur/cli`

`src/main.ts` (shebang `#!/usr/bin/env node`) + one module per command in `src/commands/` (file names per oss-spec §2 plus `daily.ts`, `weekly-plan.ts`, `login.ts`, `reject.ts`). Shared `src/ui.ts` (picocolors; respects `NO_COLOR`; `--json` flag on list/status commands prints machine-readable JSON). Exit codes: 0 success, 1 runtime error, 2 usage/validation. Behavior summary:

| Command | Behavior (M1) |
|---|---|
| `init` | analyzeRepository → generateInitPlan → print detection summary → confirm (auto-yes with `--yes`) → applyInitPlan (`--force` overwrites) → print generated files |
| `workflows list` / `workflows explain <id>` | catalog from `.excalibur/workflows/` if present else DEFAULT_WORKFLOWS; explain prints phases/levels/artifacts |
| `models list` | providers from `.excalibur/models/providers.yaml` else defaults; flags real providers as "available in M2" |
| `ask/explain/review` | builds prompt (selection/file/`--diff` via getLocalDiff) → MockProvider → prints markdown answer; `review <path>` reads the file |
| `patch "<task>"` | creates a local patch artifact set under `.excalibur/runs/` via a `propose-patch` run; prints diff + patch id (= run id) |
| `apply <id>` / `branch <id>` / `reject <id>` | apply: confirm + `patch_applied { simulated: true }` event; branch: real `createBranch` named `excalibur/<id>`; reject: marks record cancelled |
| `run "<task>"` | flags `--level 0..4`, `--fast/--careful/--structured/--explore`, `--workflow <id>`, `--output <type>`, `--yes`; selectWorkflow → RunManager → executeLocalRun with NativeAgentAdapter + MockProvider; streams events to terminal; prints artifacts dir |
| `status` / `logs [runId]` | latest/all runs table; logs prints events.jsonl prettified (`--follow` not needed in M1) |
| `daily` / `weekly-plan` | generateDailyReport / generateWeeklyPlan → print + write to `.excalibur/reports/` |
| `discovery "<idea>"` | flags `--type <DiscoveryInputType>`, `--from-file <path>`, `--yes`; interactive question pack → DiscoveryManager → prints readiness card + next-action suggestions filtered by recommendation; `--from-linear/--from-jira/--from-github-issue` print honest "available in M4" notice; `status --discovery` lists local sessions |
| `doctor` | checks: node version, git available, repo detected, `.excalibur/` present/valid, providers config valid, enterprise credentials present (optional), prints PASS/WARN/FAIL lines, exit 1 on FAIL |
| `pr-summary` | prints latest run's pr-summary.md or generates one from latest run |
| `pr-create`, `cmux` | honest stubs: explain which milestone activates them (OSS-9 / OSS-10); `pr-create` checks `gh` presence |
| `extensions list` | all loaded extensions + contributions with source column (built_in/project/local), warnings shown; `--json` |
| `extensions validate` | validates every manifest + declarative file reachable from the repo, readable errors, exit 2 on invalid |
| `extensions doctor` | diagnoses load errors, missing entrypoints, permission warnings |
| `extensions enable <id>` / `disable <id>` | edits `.excalibur/extensions.yaml` |
| `extensions install <path>` | copies a local extension folder into `.excalibur/extensions/` after validating its manifest; npm sources print an honest M8 notice |
| `extensions create <type> <name>` | scaffolds per spec doc §9: declarative types → manifest + YAML + README under `.excalibur/extensions/<name>/` (or `extensions/` arg); programmatic types → manifest + package.json + tsconfig + src/index.ts with defineExtension + README (not compiled/loaded until the user builds it) |
| `methodologies list` | methodologies from the contribution registry, with source column |
| `instructions scan` / `list` / `inspect <id>` / `enable <id>` / `disable <id>` / `import <id>` / `doctor` | per `instructions-skills-core.md` §7: list table (ID/TYPE/SCOPE/TRUST/ENABLED/PATH, user-global trust shown as trusted-local); enable/disable persist to config.yaml; `import` copies into `.excalibur/instructions/` and for user_global sources requires explicit `--include-global`; `doctor` flags missing/changed (hash) sources |
| `skills list` / `inspect <id>` / `enable <id>` / `disable <id>` | skills with trust level; `enable` on a review_required skill asks for explicit confirmation (`--yes` alone is NOT enough — require `--accept-risk`) |
| `login` / `connect` / `sync` | experimental: save credentials; `sync` pushes latest run via HttpEnterpriseSyncClient, clearly labeled experimental |

The CLI agent also owns root `README.md` and `docs/*.md` user guides (getting-started, configuration, autonomy-levels, workflows, methodologies, providers, agents, security, enterprise-sync, cmux). A separate agent owns `docs/extensions/*.md` (overview, declarative-extensions, programmatic-extensions, extension-manifest, creating-a-methodology, creating-a-workflow, creating-a-question-pack, creating-a-work-item-provider, creating-a-communication-provider, creating-a-tool, security-model, testing-extensions, publishing-extensions) and `examples/extensions/` (declarative-discovery-pack, declarative-safe-refactor, declarative-fast-fix-workflow, declarative-pr-summary-template, programmatic-custom-command-agent — each validating with `extensions validate`).

## 5. `.excalibur/` layout

Exactly as oss-spec §4. `excalibur init` creates it; every command must work without it (defaults).

## 6. Run artifacts

Exactly as oss-spec §11. `run.json` = `RunRecord`. `events.jsonl` = one `ExcaliburEvent` per line. `model-calls.jsonl` = one line per gateway call `{ provider, model, inputTokens, outputTokens, costCents, timestamp }`.

## 7. Mock determinism (important for tests and demos)

`MockProvider` output is a pure function of its input: take `sha256(JSON.stringify(messages))`, use it to (a) pick stable phrasing variants, (b) derive fake latency 30–80 ms. Output is selected by `metadata.kind` (`'review' | 'explain' | 'ask' | 'plan' | 'patch' | 'summary' | 'alternatives' | 'test_generation'`, default `'ask'`): each kind has a realistic markdown template that quotes a truncated portion of the user content. The `patch` kind returns a unified diff fenced block: target paths are any file paths detected in the prompt (regex `[\w./-]+\.(ts|js|tsx|py|go|rb|java)`), else `src/example.service.ts`; diff shows a plausible guard-clause/idempotency fix (3–10 changed lines, valid unified diff syntax). `usage.inputTokens/outputTokens` via `estimateTokens`. Never claim the output came from a real model — templates start with a `> Mock provider (M1)` quote line.

## 8. Definition of Done (every package)

`pnpm --filter ...<pkg> build` green → `pnpm --filter <pkg> typecheck` green → `pnpm --filter <pkg> test` green with meaningful coverage of the pinned API → `pnpm --filter <pkg> lint` clean. End your work with a short report: what you built, test count, any contract deviations or concerns.
