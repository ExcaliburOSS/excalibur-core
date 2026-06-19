# Agentic Agile — Excalibur Core scope (AA-8)

Agentic Agile is an optional Enterprise module that adapts lightweight agile rituals to agentic development (daily async summaries, weekly planning facilitation, human supervision tracking, decision capture, Slack/Teams). The full module lives in Excalibur Enterprise.

Excalibur Core implements only a **lightweight local version**:

```bash
excalibur daily
excalibur weekly-plan
```

Local behavior:

- Summarize local git activity (commits/branches since the period start).
- Summarize local Excalibur runs (from `.excalibur/runs/`).
- Summarize local patches.
- Optionally read GitHub issues through CLI/token (later milestone).
- Output markdown to the terminal.
- Optionally write to `.excalibur/reports/`:

```text
.excalibur/reports/
  daily-2026-06-12.md
  weekly-plan-2026-W25.md
```

OSS must NOT include enterprise Slack scheduling. Enterprise adds: scheduled posting, Slack/Teams integration, team sessions, work item sync, planning decisions, owner assignments, governance and audit.

The planning command vocabulary (`@excalibur daily`, `@excalibur planning start|propose|approve|revise|add|remove|owner|careful|run`) is parsed by the common command parser in `@excalibur/work-items`.

Design rule: Agentic Agile never forces a team to adopt a specific agile methodology. It is a facilitation layer — configurable, optional, respectful of existing tools. It should reduce meetings and improve clarity, not add bureaucracy.
