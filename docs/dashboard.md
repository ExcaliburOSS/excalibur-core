# Web dashboard

Excalibur ships a local, **task-first** web dashboard, served by the CLI itself —
no separate process, no build step, no account. It is the browser counterpart to
the terminal shell: the home is a kanban board of your work items, and you drill
into a work item to see everything that hangs off it (runs, the active run's live
checklist, patches, PRs, plans, discovery).

## Start it

```bash
excalibur serve                 # http://127.0.0.1:4319  (read-only)
excalibur serve --write         # + interactive: drag lanes, start/cancel/approve runs
excalibur serve --share         # + mint a READ-ONLY share token (prints a view URL)
```

`serve` is **localhost-bound and token-gated** by default: it prints a per-process
token and the URL to open (`…/?token=…`). It is read-only unless you pass
`--write`. Options: `--port` (default `4319`), `--host` (default `127.0.0.1`),
`--token` (default: a random per-process token).

> The dashboard is a Svelte SPA compiled to a single self-contained file and
> embedded in the CLI bundle, so `excalibur serve` just works offline.

## What you get

- **Board (home).** Five lanes — Backlog / To do / In progress / Review / Done —
  with your work items as cards. A card with an in-flight run shows a live
  indicator and the agent's current `update_tasks` checklist (progress + items),
  so you see the plan without opening the run. Auto-refreshes live (SSE).
- **Work-item drill-down.** Title, status, labels, assignee + the runs that
  advanced it (newest first), linked PRs/commits, comments and plans.
- **Runs explorer.** Every run with a live filter across title/id/status/
  workflow/model; click into a run's live rail.
- **Insights.** Totals (runs, cost, tokens, completion rate) + a cost-by-day
  chart and per-model / per-workflow breakdowns.
- **Plans & Discovery.** Saved plans (expand to read the markdown body) and
  discovery sessions with their recommendation + readiness level.

## Interactive mode (`--write`)

With `--write`, the board becomes a control plane (still localhost + token-gated):

- **Drag a card** to another lane to change its status (or the keyboard ◀ ▶
  buttons for an accessible move).
- **Start a run** on a card; **cancel** a running run; **approve / reject** a run
  that is waiting on a gate — all from the work-item view.

A run started here uses your configured provider (it refuses if no model is
configured) and links to the work item.

## Sharing

Two complementary ways to share, neither requiring Excalibur-hosted infra:

- **Live, read-only:** `excalibur serve --share` mints a second token that can GET
  everything but is always refused any mutation (even with `--write` on), and
  reports `write:false` to the page so its actions are hidden. Hand someone the
  printed `…/?token=<share>` URL.
- **Static snapshot:** `excalibur share <runId>` writes a single self-contained
  HTML file (`.excalibur/shares/<id>.html`) of a run — open it offline or host it
  on any static host. No server.

## HTTP API

The dashboard is a thin client over a small JSON + SSE API (same token):

| Method | Path                                                           | Returns                                                   |
| ------ | -------------------------------------------------------------- | --------------------------------------------------------- |
| GET    | `/health`                                                      | `{ ok, service, repoRoot, write }`                        |
| GET    | `/api/board`                                                   | the kanban board (lanes + cards)                          |
| GET    | `/api/board/stream`                                            | SSE: a board snapshot pushed on every change              |
| GET    | `/api/work-items/:key`                                         | one work item + its runs/links/comments/plans             |
| GET    | `/api/runs` · `/api/runs/:id`                                  | run records · one run's record + reduced rail             |
| GET    | `/api/runs/:id/events` · `/stream`                             | the event log (cursor-paged) · live SSE                   |
| GET    | `/api/insights`                                                | cross-run cost/token/outcome aggregate                    |
| GET    | `/api/plans` · `/api/plans/:id` · `/api/discovery`             | plans + discovery                                         |
| GET    | `/api/orchestrations` · `/stream`                              | parallel runs (parent + per-lane child runs) · live SSE   |
| GET    | `/api/orchestrations/:id` · `/stream`                          | one orchestration's wave/DAG chronogram · live SSE        |
| POST   | `/api/runs` (+`workItemId`) · `/api/runs/:id/{cancel,approve}` | run control (write)                                       |
| POST   | `/api/work-items/:key/move`                                    | change a work item's lane (write)                         |
| POST   | `/api/orchestrations/:id/pause`                                | pause/resume a live orchestration (write)                 |
| POST   | `/api/orchestrations/:id/lanes/:laneRunId/cancel`              | cancel one lane of a live orchestration (write)           |
| POST   | `/api/plan-shape`                                              | clarifying questions + recommendations for a task (write) |

POST routes require `--write` (else `403`); a share-token request is refused all
POSTs. It is single-user and localhost by default — keep the token secret and the
bind local.

The dashboard also surfaces the **Orchestrations** page (parallel swarms with their
per-lane child runs, the work item each lane advances, pause/resume + per-lane
cancel), a live **chronogram** (wave/DAG timeline with a time-travel scrubber), and
a **plan-shaping** panel that co-creates a plan before starting a build. See
[orchestration.md](orchestration.md).
