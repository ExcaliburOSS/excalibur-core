# CMUX integration

> **CMUX is an optional convenience, not a dependency.** Parallelism is already **native** today — see [orchestration.md](orchestration.md): `swarm`, `explore`, the live chronogram, and background `/bg` threads all run from a single terminal. The `excalibur cmux` _pane‑integration_ command is still a stub (it prints an honest notice and lands in milestone OSS‑10); nothing about parallel agents waits on it.

[CMUX](https://github.com/wandb/cmux) is a terminal multiplexer for agentic coding sessions. The planned integration:

```bash
excalibur cmux run "Refactor billing service" --agents 3
```

- Detect whether CMUX is installed (`excalibur cmux` already does this).
- Generate workspace/session configuration where possible.
- Open one pane per concern: planner, implementer, reviewer, tests, logs.
- Keep all artifacts in `.excalibur/runs/` — the same format as single-terminal runs.

If CMUX is not installed, Excalibur shows instructions instead of failing.

## Until then

CMUX is only ever a convenience layer — **parallelism is already native**, no
multiplexer required. `excalibur swarm` (or `/swarm`) fans a task across
isolated git worktrees and grades the candidates; `/bg` runs a task in the
background and `/threads` juggles several at once; `excalibur serve` shows every
run live in the dashboard.

```bash
excalibur run "Refactor billing service" --structured
excalibur swarm "Refactor billing service" --agents 3 --grade
excalibur logs            # the event stream the panes would show
excalibur status
```
