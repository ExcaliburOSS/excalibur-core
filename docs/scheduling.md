# Scheduling & background work

Excalibur can run work **while you keep typing**, **react when a background task finishes**, and **fire tasks on a schedule** — the autonomous half of the agent. All of it is bounded (anti‑runaway) and off unless you opt in or grant autonomy.

## Background threads — `/bg` and `/threads`

In the interactive shell, send a task to the background and keep working:

```
/bg run the full test sweep and summarize the failures
/threads          # list the background fleet (running · done · failed)
```

A background thread runs quietly to its own recorded run (auto‑approved, no live rail). When it finishes, a one‑line banner appears above your next prompt. Blocked paths stay hard‑denied at the tool layer, so a background task can never escape your safety floor.

### Chaining — react when it finishes

A `/bg` request can carry a follow‑up: _"build the parser **and then** run the tests"_ is split (by a model, any language) into a primary task + an auto‑follow‑up that dispatches **when the first thread completes** — no second command. Auto‑spawned chains are depth‑bounded so they can never fork‑bomb.

### The completion supervisor

When a background thread settles with **no** explicit follow‑up, a fast model can decide the next action — `done`, `continue` (dispatch a follow‑up), or `escalate` (surface a note). It is **proactive by default at full autonomy** and opt‑in below it:

```yaml
# .excalibur/config.yaml
orchestration:
  superviseBackground: true # also supervise BELOW full autonomy (offers rather than auto-acts)
  # superviseBackground: false  # disable it even at full autonomy
  # (unset)                     # ON automatically when approvals.auto is on
```

At full autonomy a `continue` auto‑dispatches the follow‑up; below it, the supervisor _suggests_ the next step instead of acting. Every reaction is bounded by the same anti‑loop cap as chaining.

## The scheduler — `excalibur schedule`

Run a task on a recurring cadence — the OSS analog of cron / wake‑ups. Jobs persist to `.excalibur/schedules.json`; **nothing fires** unless the daemon (`schedule run`) or `excalibur serve` is alive.

```bash
excalibur schedule add "every 2h" "run the test sweep and open issues for new failures"
excalibur schedule add "at 09:00" "regenerate the API docs"
excalibur schedule list
excalibur schedule remove <id>
excalibur schedule run            # the daemon: ticks, fires due jobs as real runs, reschedules (blocks until Ctrl-C)
```

Cadence formats: an **interval** (`every 30m` / `2h` / `1d`) or a **daily time** (`at 14:30` / `daily 09:00`, 24‑hour). The daemon is drift‑free (an interval is anchored to its scheduled slot) and never replays a storm of missed slots if it was down — it fires once and realigns.

### Scheduling in plain language

You don't need the command. In the shell, just say it:

```
every morning run the test sweep and flag regressions
cada noche publica el informe de cobertura
chaque heure, lance la suite de tests
```

The intent router (LLM, multilingual, never keyword matching) recognises a recurring request, normalises the cadence (`"every morning"` → `at 09:00`, `"nightly"` → `at 22:00`, `"hourly"` → `every 1h`), and persists the job. It confirms the exact parsed schedule before committing (and just creates it at full autonomy, always showing what it scheduled). Duplicate phrasings don't pile up duplicate jobs, and the number of NL‑created jobs is capped.

> Secrets in a scheduled task are redacted before they touch disk, and `schedules.json` is written `0600` — the task is re‑sent to the model on every fire, so it must not leak a credential.

## Where to go next

- [Orchestration](orchestration.md) — parallel swarms, best‑of‑N, the chronogram.
- [Autonomy levels](autonomy-levels.md) — what the supervisor may do without asking.
- [Security defaults](security.md) — the safety floor a background task can't escape.
