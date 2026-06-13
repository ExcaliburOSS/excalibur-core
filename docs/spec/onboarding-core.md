# Simple Out-of-the-Box Onboarding — Excalibur Core scope

> No configuration before value. Simple by default, configurable when needed. Onboarding should produce confidence before configuration.

Target first-use flow (must work in minutes, without the user understanding methodologies, workflows, extension packs, policies, precedence, adapters or routing):

```bash
npx excalibur init
excalibur review --diff
excalibur patch "Fix duplicated webhook handling"
excalibur run "Implement a small safe change"
```

## 1. `excalibur init` (default = minimal mode)

Does a lot automatically, asks almost nothing: repo/structure/language/framework/package-manager detection, command detection (omit undetectable commands — never invent), instruction discovery (ISD — see instructions-skills-core.md), optional model provider setup (one question), safety preset activation, **minimal** `.excalibur/` generation, friendly next-step output.

Detection additions beyond context-engine's existing pins: monorepo markers (pnpm-workspace.yaml, turbo.json, nx.json), CI (.github/workflows/**), Docker (Dockerfile, docker-compose.yml), more frameworks (vite/nuxt/next/nest configs, pytest/pyproject, go.mod, Cargo.toml, pom.xml, build.gradle). Commands map through the detected package manager (`"test": "vitest"` + pnpm → `pnpm test`).

**Minimal mode generates ONLY:**

```text
.excalibur/config.yaml
.excalibur/instructions/general.md
.excalibur/extensions.yaml          # implementation decision: keeps registry explicit
[.excalibur/models/providers.yaml]  # only if model setup completed
[AGENTS.md]                         # repo root — bootstrapped ONLY when absent (see below)
```

**Root `AGENTS.md` (cross-tool standard, OpenCode-style).** All init modes also bootstrap an `AGENTS.md` at the **repository root** when one does NOT already exist, generated deterministically from the analysis (stack, commands, layout, sensitive areas). It is the standard read by Excalibur, Cursor, Copilot, OpenCode et al., so it benefits the whole toolchain. An existing AGENTS.md is **never overwritten** — ISD detects and references it instead (existence is detected via `instructionSources`, so even `--force` leaves it untouched). AI enrichment of the generated prose arrives in M2.

Built-in workflows/methodologies/policies work WITHOUT local files (registered via built-in extensions). Never overwrite existing files without confirmation; if `.excalibur/` exists, run in update mode showing a diff-style "would change" list before applying.

## 2. Default `config.yaml` shape (extends the shared config schema)

```yaml
version: 1
project:
  name: quickcontract-api
  packageManager: pnpm
  languages: [typescript]
  frameworks: [nestjs]
commands:            # top-level (project.commands remains accepted alias, normalized to this)
  test: pnpm test
  lint: pnpm lint
  typecheck: pnpm typecheck
  build: pnpm build
instructions:
  sources: []        # only detected sources, never non-existent paths
safety:
  preset: standard-safe
workflowDefaults:
  ask: ask-repo
  review: review-only
  patch: propose-patch
  run: standard-feature
  careful: structured-feature
  discovery: discovery
autonomyDefaults:
  ask: 1
  review: 0
  patch: 2
  run: 3
  careful: 4
  discovery: 0
```

## 3. Init modes

- `excalibur init` — minimal (above).
- `excalibur init --team` — shared repo standards: + instructions/{architecture,testing,security}.md, policies/{standard-safe,sensitive-paths}.yaml, models/{providers,routing}.yaml; asks "version Excalibur config in Git? [Y/n]"; still short.
- `excalibur init --full` — exports ALL built-in defaults (methodologies/, workflows/, question-packs/, prompts/, artifacts/, policies/, models/, reports/, roles/, command-mappings/) for inspection/customization. Never the default.

## 4. Model provider setup (ONB-3)

One question when unconfigured: `1. OpenAI-compatible  2. Anthropic  3. OpenRouter  4. Ollama local  5. Mock (built-in, default in M1)  6. Configure later`. If Ollama detected locally (binary on PATH or :11434 responds), highlight it. For hosted providers ask for the **env var name only** — never the key value; never store raw keys in `.excalibur/`. OpenRouter = openai-compatible with baseUrl https://openrouter.ai/api/v1. "Configure later" still completes init; commands needing a model later show the guided chooser (§7), never a low-level error. `excalibur models setup` reruns this flow. M1 honesty: chosen real providers are written to providers.yaml but execution stays on the mock until M2 — say so.

## 5. Safety preset `standard-safe` (ONB-6; supersedes the `safe-defaults` id)

Blocked paths: `.env, .env.*, **/*.pem, **/*.key, **/*.p12, **/*.pfx, **/secrets/**, **/.ssh/**, node_modules/**, dist/**, build/**, .git/**`.
Permissions: read allowed except blocked; write files **ask**; apply patch **ask**; run detected test/lint/typecheck/build **ask first time** (then session-allowed); unknown commands **ask always**; create branch **ask**; push **disabled**; open PR **ask**; external network tools **disabled** unless explicitly enabled; secrets redacted from prompts/logs. Default prompt answers are the safe ones (`[y/N]` for risky, `[Y/n]` for safe). Every run prints the active preset: `Safety: standard-safe — No files will be modified without approval.`

## 6. Command → workflow/autonomy mapping (ONB-5) + intent heuristics (§10)

| Command | Entity | Level | Workflow | Notes |
|---|---|---|---|---|
| `ask` | interaction | 1 | `ask-repo` | never changes code |
| `review [--diff]` | interaction | 0 | `review-only` | never changes code |
| `patch` | patch | 2 | `propose-patch` | apply requires confirmation |
| `run` | run | 3 | `fast-fix` or `standard-feature` by intent | branch/worktree isolation when possible |
| `run --careful` | run | 4 | `structured-feature` / `security-review` / `migration` by intent | stronger approvals |
| `run --explore` | run | 3–4 | `explore-alternatives` | "engineering alternatives", never "model comparison" |
| `discovery` | discovery | 0–1 | `discovery` | never changes code |

`classifyTaskIntent` heuristics (deterministic, keyword/context-based): small bugfix (fix/bug/typo/broken + narrow scope) → fast-fix; normal feature → standard-feature; ambiguous (no clear verb/criteria, very short or vague) → recommend running Discovery first (`[Y/n]` prompt); asks for alternatives/approaches → explore-alternatives; sensitive (auth, billing, payments, contracts/signing, security, PII, legal, migrations, infrastructure — plus config `autonomy.paths` hits) → recommend careful with security-review/migration/structured-feature; weak/no detected tests + risky task → recommend plan-only/patch before agent run. The run prompt shows the choice and allows changing: `Using: Fast Fix  [Enter] continue [m] change mode [c] cancel`. Never present a long workflow list by default.

New built-in workflow **`ask-repo`** (14th): mode `fast`, levels [1], single `assistant_interaction` phase (role planner, output `answer.md`, modifiesFiles false). New built-in methodology **`agentic-agile-light`** (14th): category delivery, lightweight async rituals (daily/weekly local reports), levels [0,1], defaultWorkflow ask-repo.

## 7. Local artifacts for every meaningful command (ONB-8)

```text
.excalibur/runs/<run-id>/            (existing)
.excalibur/patches/<patch-id>/       input.md, effective-instructions.md, diff.patch, summary.md, metadata.json
.excalibur/interactions/<int-id>/    input.md, effective-instructions.md, output.md, metadata.json
.excalibur/discovery/<disc-id>/      (existing)
```

IDs: `patch_YYYYMMDD_HHMMSS`, `int_YYYYMMDD_HHMMSS`. `metadata.json` records command, workflow, autonomy level, model/provider, instruction sources used, warnings, timestamps, cost.

## 8. Doctor (ONB-9) and final output (§12)

`excalibur doctor` checks: git repo, config validity, model provider config, API key env var presence (named var set?), detected commands, instruction sources reachable (hash match), safety preset active, workflows/methodologies catalog loads, extension validity. Init final output = the confidence-building summary of the raw spec §12 (Detected / Using existing instructions / Safety / Created / Try now), plus the no-provider variant.

## 9. Progressive disclosure (§17)

Non-blocking: after ≥5 local runs, `status` appends "Useful next steps" suggestions (init --team, custom instructions, safer rules for sensitive paths, connect GitHub Issues). Informational only.

## 10. Acceptance criteria (verify phase must check §20 of the raw spec one by one)

init works without choosing methodologies/workflows · existing instructions detected · nothing overwritten silently · provider configurable without raw keys · generated `.excalibur/` is small · built-ins work without local files · standard-safe active by default · ask/review/patch/run/discovery work as simple commands · asks before modifying files/applying patches/running unknown commands · never pushes · local artifacts created · advanced config optional.
