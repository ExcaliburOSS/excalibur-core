# CMUX integration

> **Arrives in milestone OSS-10.** `excalibur cmux` currently prints an honest notice. CMUX is an _interface_, never a hard dependency — every workflow works in a single terminal without it.

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
