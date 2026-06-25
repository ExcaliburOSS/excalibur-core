# The interactive shell

Run `excalibur` with no arguments to open the **interactive shell** — the primary way to use Excalibur. It is **model‑first**: you type in plain words (any language) and the model decides whether to answer, edit, or run, governed by your [autonomy level](autonomy-levels.md). Only two inputs are _structural_ (syntax, not language):

- a leading **`/`** → a slash command;
- a leading **`!`** → run the rest as a shell command.

Everything else is a natural‑language turn.

## Intent routing (no commands required)

A natural‑language turn is classified by an LLM — **never** by keyword matching, so it works the same in English, Spanish, French, … — into the execution shape that fits, and Excalibur picks it for you:

| Intent        | What it does                                                       |
| ------------- | ------------------------------------------------------------------ |
| chat          | answer a question or make one small direct change                  |
| plan          | a multi‑step build worth planning first (plan → approve → execute) |
| swarm         | many independent subtasks → fan out to parallel agents             |
| bg            | a long‑running task → run it in the background                     |
| research      | needs current/external web info → cited multi‑source research      |
| goal          | "keep iterating until it works/passes/done"                        |
| explore       | "try a few approaches and pick the best" (best‑of‑N)               |
| orchestration | view / pause / resume an existing parallel run                     |
| schedule      | run a task on a recurring cadence ("every morning run …")          |

The choice is **confidence‑graded**: on a safe, confident read it just acts; on a high‑impact one it announces while acting (under full autonomy) or asks first; on an unsure read it asks. No flags — see [autonomy levels](autonomy-levels.md). So "investiga lo último de React 19", "build a checkout flow", and "every night publish the report" each route themselves without you naming a command.

## Slash commands

| Command                                  | What it does                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `/help`                                  | show the command list                                                        |
| `/plan <task>`                           | plan first (read‑only) → approve → execute                                   |
| `/goal <objective>`                      | work toward it across turns until an evaluator says done                     |
| `/loop [--every s] [--times n] <prompt>` | re‑run periodically until Esc                                                |
| `/swarm <task>`                          | fan out to real parallel agents (see [orchestration](orchestration.md))      |
| `/explore <task>`                        | best‑of‑N: run candidate approaches in parallel, keep the best               |
| `/bg <task>`                             | run a task in the background while you keep working                          |
| `/threads`                               | list the background threads (running + finished)                             |
| `/discovery <idea>`                      | clarify an ambiguous idea before building                                    |
| `/rewind [id]`                           | step through a past run (time‑machine; defaults to latest) · `Esc Esc`       |
| `/changes [id]`                          | show a run's full changed‑file list                                          |
| `/fork <instr>`                          | fork the latest run (reuse its cached context) and run `<instr>` live        |
| `/undo`                                  | revert the working tree by undoing the latest run (gated)                    |
| `/compact`                               | condense older turns into a summary (frees context)                          |
| `/remember <x>`                          | save a decision/risk/convention; future runs touching those paths are primed |
| `/models`                                | pick the default + fast model interactively                                  |
| `/agent`                                 | switch the active [custom agent](agents.md) persona                          |
| `/model`                                 | show the active provider/model                                               |
| `/clear`                                 | clear the screen (keeps the session)                                         |
| `/exit`, `/quit`                         | close the session and leave                                                  |

Slash commands **ghost‑complete** as you type — the most likely command appears as dimmed text; press `→` to accept it. Single‑key bindings only (no modifier combos); they are [rebindable](configuration.md).

## Shell passthrough

```
!pnpm test
!git status
```

A leading `!` runs the rest in your shell and streams the output inline — handy without leaving the session. Network/destructive commands are still governed by your [security defaults](security.md).

## Where to go next

- [Autonomy levels](autonomy-levels.md) — what runs automatically vs. asks first.
- [Orchestration](orchestration.md) and [Scheduling & background](scheduling.md) — the heavy routes.
- [Agents](agents.md) — custom personas you switch with `/agent`.
- [Getting started](getting-started.md) — a first end‑to‑end session.
