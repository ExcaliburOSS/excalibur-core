# Autonomy levels

Excalibur treats autonomy as a **dial with five positions**, identical in Excalibur Core and Excalibur Enterprise. You rarely type the numbers — friendly commands map onto them — but every artifact records the level it ran at.

| Level | Name                  | What the AI may do                                                 | Default command                 |
| ----- | --------------------- | ------------------------------------------------------------------ | ------------------------------- |
| 0     | Review                | Read and review code; never modifies anything                      | `excalibur review --diff`       |
| 1     | Assist                | Explain, answer questions, suggest — no automatic diffs            | `excalibur ask "..."`           |
| 2     | Propose Patch         | Generate a patch/diff; **never applies it automatically**          | `excalibur patch "..."`         |
| 3     | Implement in Branch   | Create/use a local branch or worktree and modify code in isolation | `excalibur run "..."`           |
| 4     | Full Agentic Workflow | Execute a full workflow with phases, tools, tests and outputs      | `excalibur run "..." --careful` |

## How a level is chosen

Priority, highest first:

1. **Explicit flag** — `excalibur run "..." --level 2`.
2. **Execution style** — `--careful` implies Level 4; `--fast`/`--structured`/`--explore` imply Level 3+.
3. **Task intent** — the deterministic classifier raises the recommendation for sensitive areas (auth, billing, payments, migrations, security, PII, infrastructure) and lowers it for ambiguous tasks (recommending Discovery at Level 0 first).
4. **Configuration** — `autonomyDefaults` (per command) and `autonomy.default`.

## Per-path autonomy

```yaml
autonomy:
  default: 2
  paths:
    'src/billing/**': 1 # assistance only in billing code
    'src/auth/**': 1
    'src/contracts/signing/**': 2
  allowFullAgentic:
    - 'src/docs/**' # level 4 allowed here
    - 'src/tests/**'
```

Paths mentioned in a task that match a restrictive `autonomy.paths` entry mark the task as **sensitive**: the run prompt recommends a careful workflow with stronger approvals.

## What each level guarantees

- Levels 0–2 **never touch your working tree** — they read, review and write artifacts under `.excalibur/` only.
- Levels 3–4 act for **real**: file writes, command execution and patch application happen on your working tree — but every mutating action is gated by the Permission Engine and your approval (mutating tools default to _ask_; blocked paths are hard-denied; commands outside the allowlist need confirmation). Prefer `excalibur branch <patch-id>` to land a patch on a fresh branch.
- All levels honor the active safety preset, printed at the start of every run:

```text
Safety: standard-safe — No files will be modified without approval.
```

## Workflows by level

The workflow selector maps levels and styles onto the catalog:

| Level | Style        | Workflow                                                            |
| ----- | ------------ | ------------------------------------------------------------------- |
| 0     | —            | `review-only` (`security-review` for security tasks)                |
| 1     | —            | `assist`                                                            |
| 2     | —            | `propose-patch` (`safe-refactor` for refactors)                     |
| 3     | fast         | `fast-fix`                                                          |
| 3     | structured   | `structured-feature`                                                |
| 3     | explore      | `explore-alternatives`                                              |
| 3     | careful      | `standard-feature`                                                  |
| 3     | team default | config `workflows.byTaskType` → config default → `standard-feature` |
| 4     | explore      | `explore-alternatives`                                              |
| 4     | careful      | `human-gated`                                                       |
| 4     | otherwise    | `structured-feature`                                                |

See [workflows.md](workflows.md) for the catalog.
