# Orchestration

Excalibur runs work as **parallel agents** when that is faster, and keeps every parallel run a first‑class, observable, verifiable artifact. You almost never have to ask for this: the planner reads your request, **picks the execution shape itself** (a single focused run, a parallel swarm, best‑of‑N, or a background thread) and sizes it to the task. The commands below are the explicit escape hatches for when you want to drive it by hand.

> **Why this is different.** Each lane runs in its **own isolated git worktree**; the merged result is **verified against ground truth** (your test command + an adversarial review mesh) _before_ it touches your tree, and the whole graph — budget, gates, dependencies — lives **outside** the model context, so a run is repeatable, auditable and crash‑resumable. That combination is what lets Excalibur pick best‑of‑N by real test exit codes rather than a guess.

## Auto‑orchestration (no command needed)

In the interactive shell, just describe the work. The intent router (LLM, any language — never keyword matching) detects when a request is parallelizable and the planner **decomposes it, sizes the swarm to your CPU headroom, and fans out** — or keeps it a single run when that is the right shape. Under full autonomy it just runs; otherwise it asks first. You can still reach every shape explicitly:

| You want…                                       | Command                                    | In‑shell          |
| ----------------------------------------------- | ------------------------------------------ | ----------------- |
| Fan independent subtasks out to parallel agents | `excalibur swarm "<task>"`                 | `/swarm <task>`   |
| Try several approaches and keep the best        | `excalibur explore "<task>"`               | `/explore <task>` |
| Re‑run or resume a past parallel run            | `excalibur orchestrate [runId] [--resume]` | —                 |
| Run an author‑defined orchestration spec        | `excalibur orchestrate --spec <name>`      | —                 |
| Watch / pause / resume a live run               | `excalibur orchestration [runId]`          | natural language  |

## `swarm` — parallel agents over independent subtasks

A model decomposes the task into independent subtasks, the allocator sizes the swarm, and one real agent loop runs per subtask in its own worktree. Their diffs are **fanned in** (textual conflicts auto‑3‑way‑merged; genuine same‑line conflicts reported) and the merged diff is offered for apply.

```bash
excalibur swarm "add input validation to every POST route"
excalibur swarm --grade --retries 2 "..."      # grade each lane, revise failing lanes until they pass
excalibur swarm --max-agents 4 "..."           # cap the parallelism
excalibur swarm --work-item WI-12 "..."        # link every lane to a work item
excalibur swarm --apply "..."                  # apply the merged result without prompting
```

A real graph (≥2 dependency waves) runs **staged**: each wave is rebased on its predecessors' merged result, so a dependent lane sees the work it depends on. A flat set of independent lanes runs all at once (bounded by the chosen concurrency).

## `explore` — best‑of‑N

Runs **N candidate approaches to the same task in parallel**, judges them by a model tournament, and applies only the winner (never a union‑merge of competing diffs). The candidate count is auto‑sized to your budget, or set it:

```bash
excalibur explore "rewrite the cache layer"            # 3 candidates by default
excalibur explore --candidates 5 "..."
excalibur explore -y "..."                              # apply the winner without prompting
```

## `orchestrate` — re‑run, resume, or author a spec

Every swarm persists an `orchestration.json` **manifest** on its parent run. `orchestrate` re‑executes it deterministically — the repeatable, crash‑recoverable half of orchestration:

```bash
excalibur orchestrate                 # re-run ALL lanes of the latest orchestration
excalibur orchestrate <runId>         # re-run a specific one
excalibur orchestrate --resume        # re-dispatch ONLY the lanes that didn't complete (+ their dependents)
```

### Authored orchestration specs

Commit a hand‑written DAG in `.excalibur/orchestrations/<name>.yaml` and run it. Auto‑orchestration stays the default; this is the opt‑in, deterministic, version‑controlled path:

```yaml
# .excalibur/orchestrations/api-migration.yaml
task: Migrate the REST API to v2
steps:
  - id: schema
    instruction: Update the request/response schemas to v2
  - id: handlers
    instruction: Port the route handlers to the new schemas
    dependsOn: [schema] # runs in a later wave, on schema's merged result
  - id: review
    instruction: Review the migration for breaking changes
    role: reviewer # a role hint for the lane
    when: on_success # conditional: only if its dependencies succeeded
    dependsOn: [handlers]
  - id: analyze
    instruction: Summarize the changed endpoints as JSON
    maxAttempts: 3 # loop-until-rubric for this step
    outputSchema: # force structured output, validated + passed to dependents
      type: object
      properties:
        endpoints: { type: array, items: { type: string } }
```

```bash
excalibur orchestrate --spec api-migration
excalibur orchestrate --spec api-migration --resume   # re-run only the EDITED steps + their dependents
```

Per‑step controls: `dependsOn` (DAG edges → waves), `role`, `when` (`always` | `on_success` | `on_failure`), `maxAttempts` (per‑step retry/loop), and `outputSchema` (JSON‑Schema‑forced structured output, validated and handed to dependents). `--resume` is **content‑addressed**: an unchanged step is reused, an edited step (and its dependents) re‑runs.

## Watch it run — the chronogram

Every orchestration renders as a **live wave/DAG timeline** in both the terminal and the web dashboard. In the shell you can just say "show me the orchestration" / "pause it" / "resume it" (any language) — or use the command:

```bash
excalibur orchestration            # the latest swarm as a wave/DAG chronogram (alias: chronogram)
excalibur orchestration <runId> --json
excalibur orchestration <runId> --pause     # a live swarm stops dispatching new lanes; in-flight lanes finish
excalibur orchestration <runId> --resume    # the held swarm continues
```

In the **web dashboard** (`excalibur serve`), the Orchestrations page shows each parent swarm with its per‑lane child runs (status, cost, the work item each lane advances), pushed live over SSE. With `serve --write` you can pause/resume the run and **cancel an individual lane**. The chronogram view adds a **time‑travel scrubber** to replay the run as of any moment.

## Trust & safety knobs (`.excalibur/config.yaml`)

Auto‑orchestration sizes itself; these only cap the autonomous loops and add verification gates. All are opt‑in (default off) except where noted:

```yaml
orchestration:
  goalMaxIterations: 6 # hard cap for the autonomous `/goal` loop
  verifyMerge: true # run the configured test on the MERGED tree before keeping it; a red run reverts the merge
  verifyWaves: true # in a staged swarm, verify each wave (test + adversarial mesh) before its dependents run; roll back a red wave
  selfHeal: true # on lane exhaustion, fire ONE bounded heal attempt with the failure context before giving up
  superviseBackground: true # supervise `/bg` completions (see Scheduling & background) — proactive by default at full autonomy
```

`verifyMerge` needs a `commands.test` configured (see [configuration.md](configuration.md)); the swarm also runs a **proportional adversarial verification mesh** over the merged diff, and a surviving high‑severity finding reverts the merge. A shared budget ledger binds across all lanes: once `budget.maxRunUsd` is hit the swarm stops dispatching new lanes and the finished lanes are the partial result.

## Where to go next

- [Scheduling & background work](scheduling.md) — `/bg`, the completion supervisor, and the autonomous scheduler.
- [Web dashboard](dashboard.md) — the Orchestrations page, chronogram, and the `/api`.
- [Work items & kanban](work-items.md) — what `--work-item` links a swarm to.
- [Autonomy levels](autonomy-levels.md) — what runs automatically vs. asks first.
