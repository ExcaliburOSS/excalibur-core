# Work items & the kanban board

Work items are Excalibur's unit of planning. The whole dev cycle revolves around
them: runs, patches, PRs and discovery sessions **link to a work item**, and both
the terminal `work-items board` and the [web dashboard](dashboard.md) are
task-first views of the same data. They live as plain files under
`.excalibur/work-items/WI-<n>.json` — Git-versionable, no database, no account.

## CLI

`excalibur work-items` (alias `issues`) manages a **local** backlog or, with
`--repo`/no `--local`, GitHub Issues via the `gh` CLI.

```bash
excalibur work-items create "Add idempotency to the escrow webhook" --label backend
excalibur work-items list                 # local backlog (or gh issues)
excalibur work-items board                # the local kanban board (lanes × items)
excalibur work-items show WI-3            # one item + body + comments
excalibur work-items move WI-3 in_progress
excalibur work-items edit WI-3 --priority high --assignee rafa
excalibur work-items comment WI-3 "blocked on the staging migration"
excalibur work-items run WI-3             # fetch the item and run it as an agentic task
excalibur work-items delete WI-3
```

`create` accepts `--body`, `--label` (repeatable) and `--json`; most commands take
`--json` for scripting.

## Lanes

The board projects every item's free-text `status` onto five canonical lanes:

```text
backlog → todo → in_progress → review → done
```

`move <key> <lane>` (or `status <key> <status>`) sets it; remote/legacy statuses
(`open`, `closed`, `in-progress`, …) are mapped onto a sensible lane
automatically, so a GitHub issue and a local item sit on the same board.

## The agent-native bridge

`work-items run <key>` is the link between planning and execution: it reads the
item (title + body) and starts an agentic run **linked to that work item**, so the
run, its patch, and any PR all hang off the item. On the dashboard the item's card
then shows the run's live `update_tasks` checklist and, once done, its runs and
links. Discovery sessions can also create/seed a work item (intent-routed
planning), and `excalibur discovery --from-github-issue <id>` seeds one from a
GitHub issue via `gh`.

## In the dashboard

`excalibur serve` opens the board in the browser as the home view; with
`--write` you can drag a card between lanes, start a run on a card, and
cancel/approve runs — see [the dashboard guide](dashboard.md).
