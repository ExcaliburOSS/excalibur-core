# @excalibur/tui

[![Status: Public Beta](https://img.shields.io/badge/status-public%20beta-F59E0B)](https://github.com/ExcaliburOSS/excalibur-core/issues)

Terminal UI for Excalibur — Ink components and the design system that power the
conversational shell (the **M-Shell** milestone). One event model
(`ExcaliburEvent`) renders into a beautiful TUI and, later, the web Workbench.

This package is currently a **seed**: it ships the `<PhaseTimeline>` component
and an animated demo so the visual direction is tangible today.

## See the timeline animate

```bash
pnpm --filter @excalibur/tui demo
# or
cd packages/tui && pnpm demo
```

You'll see a scripted run — context → plan → implement → verify → review → PR —
with a live event stream, an inline approval prompt, a filling rail, a spinner,
and a status line (elapsed · cost · safety preset). No real model or agent is
involved; it's driven by mock data through the real component.

Set `EXCALIBUR_ASCII=1` to force the ASCII glyph set (for terminals without a
Nerd/Unicode font); `NO_COLOR` is respected by Ink.

## What's here

- `src/theme.ts` — design tokens: one accent, semantic state colours, a muted
  tone for secondary text, Unicode glyphs with ASCII fallback, spinner frames.
- `src/components/PhaseTimeline.tsx` — the run visualization, fully prop-driven.
- `src/demo-timeline.tsx` — the animated mock demo.

## Roadmap (M-Shell)

The other components — `<ThinkingIndicator>`, `<PlanReveal>`, `<AgentLanes>`
(one lane per swarm agent), `<StatusLine>` — and the interactive `excalibur`
shell that drives them live with real `ExcaliburEvent` streams land with the
M-Shell milestone.
