# Security defaults

Excalibur Core is built around one promise:

> **No files will be modified, no patches applied and no unknown commands run without approval.**

## The `standard-safe` preset

Active by default (even without `.excalibur/`), printed at the start of every run:

```text
Safety: standard-safe — No files will be modified without approval.
```

### Blocked paths (never read, never written)

```text
.env  .env.*  **/*.pem  **/*.key  **/*.p12  **/*.pfx
**/secrets/**  **/.ssh/**  node_modules/**  dist/**  build/**  .git/**
```

### Permission rules

| Action | Default |
|---|---|
| Read files (except blocked) | allowed |
| Write files | **ask** |
| Apply a patch | **ask** |
| Run detected test/lint/typecheck/build commands | **ask** first time |
| Run unknown commands | **ask always** |
| Create a branch | **ask** |
| Push | **disabled** |
| Open a PR | **ask** |
| External network tools | **disabled** unless explicitly enabled |

Prompt defaults are the safe answers: risky questions render `[y/N]`, safe ones `[Y/n]`. `--yes` skips prompts by taking the **default** — it never force-approves a risky action (for example, `excalibur patch --yes` still leaves the patch unapplied).

### Secret redaction

Prompts, logs and imported instruction files pass through redaction: OpenAI-style `sk-…`, AWS `AKIA…`, GitHub `ghp_/gho_/ghs_…`, Slack `xox…`, private key blocks, `Authorization: Bearer …`, `password=`/`apiKey:` values → `[REDACTED]`.

API keys are referenced by environment variable **name** in configuration and resolved only at call time. Key values are never stored, logged or echoed.

## Customizing

```yaml
permissions:
  tools:
    read_file: true
    write_file: ask
    run_command: ask
    network: false
  blockedPaths:
    - ".env"
    - "**/*.pem"
    - "**/secrets/**"
  allowedCommands:
    - "pnpm test"
    - "pnpm typecheck"

approvals:
  requiredFor:
    paths: ["src/billing/**", "src/auth/**", "prisma/migrations/**"]
    commands: ["npm run migrate"]
    phases: ["plan", "before_pr"]
```

Detected sensitive areas (auth, billing, payments, secrets directories, `.env*`) raise the task-intent classifier's caution: tasks touching them are recommended to run with careful workflows and stronger approvals. Restrictive `autonomy.paths` entries have the same effect.

Policy presets are declarative extensions — `excalibur init --team` exports `policies/standard-safe.yaml` and a repository-specific `policies/sensitive-paths.yaml` you can edit and review in Git.

## Skills and instruction files

- Skills (`SKILL.md`) are **never auto-executed** and never auto-enabled when they need review. Enabling a `review_required` skill requires the explicit `--accept-risk` flag.
- User-global files (`~/.claude/**`) are referenced locally only and never copied into the repository without `--include-global`.
- Secrets found in imported instruction files are redacted in the copy.
- User-global instructions can never weaken repository or enterprise safety rules.

## M1 guarantees

In this milestone the guarantees are even stronger than the preset:

- Runs **never** modify your working tree — all file writes are simulated events.
- Commands inside runs are **never executed** — simulated with `simulated: true` payloads.
- The only real git mutation is `excalibur branch <patch-id>` (after confirmation).
- The only model provider that executes is the local deterministic mock — nothing leaves your machine.

Verify your setup anytime with `excalibur doctor`.
