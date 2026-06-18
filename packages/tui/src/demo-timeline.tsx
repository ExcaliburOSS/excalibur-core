#!/usr/bin/env tsx
import { render, useApp } from 'ink';
import { useEffect, useReducer, type ReactElement } from 'react';
import { RunView } from './ink/RunView.js';
import { ThemeProvider } from './ink/ThemeContext.js';
import type { ApprovalPrompt, Phase, RailModel } from './rail-types.js';
import { getColors, resolveThemeMode } from './theme.js';

/**
 * Animated demo of <PhaseTimeline> with mock data — the M-Shell visual seed.
 *
 *   pnpm --filter @excalibur/tui demo
 *
 * Drives a scripted run (context → plan → implement → verify → review → PR),
 * including a live event stream and an inline approval, so the timeline can be
 * seen animating end to end without a real model or agent.
 */

interface DemoState {
  phases: Phase[];
  costCents: number;
  approval?: ApprovalPrompt;
  done: boolean;
  spinnerFrame: number;
  elapsedMs: number;
}

type Action =
  | { kind: 'tick'; deltaMs: number }
  | { kind: 'patch'; phases?: Phase[]; approval?: ApprovalPrompt | null; done?: boolean; costBump?: number };

const initialPhases: Phase[] = [
  { id: 'context', name: 'Context', state: 'pending' },
  { id: 'plan', name: 'Plan', state: 'pending' },
  { id: 'implement', name: 'Implement', state: 'pending' },
  { id: 'verify', name: 'Verify', state: 'pending' },
  { id: 'review', name: 'Review', state: 'pending' },
  { id: 'pr', name: 'Pull Request', state: 'pending' },
];

function reducer(state: DemoState, action: Action): DemoState {
  if (action.kind === 'tick') {
    return {
      ...state,
      spinnerFrame: state.spinnerFrame + 1,
      elapsedMs: state.elapsedMs + action.deltaMs,
      costCents: state.done ? state.costCents : state.costCents + 1,
    };
  }
  return {
    ...state,
    phases: action.phases ?? state.phases,
    approval: action.approval === null ? undefined : (action.approval ?? state.approval),
    done: action.done ?? state.done,
    costCents: state.costCents + (action.costBump ?? 0),
  };
}

/** Returns a fresh phase list with one phase replaced. */
function setPhase(phases: Phase[], id: string, patch: Partial<Phase>): Phase[] {
  return phases.map((phase) => (phase.id === id ? { ...phase, ...patch } : phase));
}

const TICK_MS = 90;

function App(): ReactElement {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reducer, {
    phases: initialPhases,
    costCents: 4,
    done: false,
    spinnerFrame: 0,
    elapsedMs: 0,
  });

  // Smooth spinner + cost/elapsed ticker.
  useEffect(() => {
    const id = setInterval(() => dispatch({ kind: 'tick', deltaMs: TICK_MS }), TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Scripted run. Each step mutates a working copy of the phases.
  useEffect(() => {
    let phases = initialPhases;
    const at = (ms: number, fn: () => void): ReturnType<typeof setTimeout> => setTimeout(fn, ms);
    type PatchExtra = { approval?: ApprovalPrompt | null; done?: boolean; costBump?: number };
    const patch = (next: Phase[], extra: PatchExtra = {}): void => {
      phases = next;
      dispatch({ kind: 'patch', phases: next, ...extra });
    };
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    timers.push(
      at(300, () => patch(setPhase(phases, 'context', { state: 'running', detail: 'scanning repository…' }))),
      at(1400, () =>
        patch(
          setPhase(phases, 'context', {
            events: [
              { text: 'read', note: 'package.json · 6 files', tone: 'muted' },
              { text: 'instructions', note: 'CLAUDE.md · AGENTS.md', tone: 'muted' },
            ],
          }),
        ),
      ),
      at(2700, () => {
        let next = setPhase(phases, 'context', { state: 'completed', detail: 'read 6 files', events: undefined });
        next = setPhase(next, 'plan', { state: 'running', detail: 'drafting steps…' });
        patch(next, { costBump: 3 });
      }),
      at(3600, () =>
        patch(
          setPhase(phases, 'plan', {
            events: [
              { text: 'guard release() behind a processed-events table', note: '~med', tone: 'warn' },
              { text: 'add idempotency key check on webhook receipt', note: '~low', tone: 'muted' },
              { text: 'tests: retry replays the same webhook', tone: 'muted' },
            ],
          }),
        ),
      ),
      at(5400, () => {
        let next = setPhase(phases, 'plan', { state: 'completed', detail: '5 steps', events: undefined });
        next = setPhase(next, 'implement', { state: 'running', detail: 'escrow.service.ts' });
        patch(next, { costBump: 4 });
      }),
      at(6200, () =>
        patch(setPhase(phases, 'implement', { events: [{ text: 'read', note: 'src/escrow/escrow.service.ts', tone: 'muted' }] })),
      ),
      // Inline approval moment.
      at(7000, () => {
        const next = setPhase(phases, 'implement', { state: 'waiting' });
        patch(next, {
          approval: { question: 'Approve write to src/escrow/escrow.service.ts?', options: '[y/N/always]' },
        });
      }),
      at(8600, () => {
        const next = setPhase(phases, 'implement', {
          state: 'running',
          events: [
            { text: 'read', note: 'src/escrow/escrow.service.ts', tone: 'muted' },
            { text: 'edit  escrow.service.ts', note: '+24 −6', tone: 'accent' },
          ],
        });
        patch(next, { approval: null, costBump: 5 });
      }),
      at(9600, () =>
        patch(
          setPhase(phases, 'implement', {
            events: [
              { text: 'edit  escrow.service.ts', note: '+24 −6', tone: 'accent' },
              { text: '▸ pnpm test src/escrow', note: 'running…', tone: 'muted' },
            ],
          }),
        ),
      ),
      at(11000, () => {
        let next = setPhase(phases, 'implement', {
          state: 'completed',
          detail: 'release() guarded',
          events: undefined,
        });
        next = setPhase(next, 'verify', { state: 'running', detail: 'commands' });
        patch(next, { costBump: 2 });
      }),
      at(11800, () =>
        patch(
          setPhase(phases, 'verify', {
            events: [
              { text: '▸ pnpm test', note: '12 passing', tone: 'success' },
              { text: '▸ pnpm typecheck', note: 'ok', tone: 'success' },
            ],
          }),
        ),
      ),
      at(13200, () => {
        let next = setPhase(phases, 'verify', { state: 'completed', detail: 'all green', events: undefined });
        next = setPhase(next, 'review', { state: 'running', detail: 'reviewing diff' });
        patch(next, { costBump: 3 });
      }),
      at(14200, () => {
        let next = setPhase(phases, 'review', { state: 'completed', detail: 'no blocking issues' });
        next = setPhase(next, 'pr', { state: 'running', detail: 'opening pull request' });
        patch(next, { costBump: 2 });
      }),
      at(15400, () =>
        patch(setPhase(phases, 'pr', { state: 'completed', detail: 'PR #128 opened' }), { done: true, costBump: 1 }),
      ),
      at(17600, () => exit()),
    );

    return () => timers.forEach((timer) => clearTimeout(timer));
  }, [exit]);

  const model: RailModel = {
    runId: 'run_20260613_143022',
    title: 'Fix duplicate escrow release on webhook retry',
    autonomyLabel: 'L3 — Implement in branch',
    phases: state.phases,
    status: {
      elapsedMs: state.elapsedMs,
      costCents: state.costCents,
      safety: 'standard-safe',
      push: false,
      model: 'qwen',
      inputTokens: 0,
      outputTokens: 0,
    },
    done: state.done,
    errored: false,
    ...(state.approval !== undefined ? { approval: state.approval } : {}),
  };
  return <RunView model={model} spinnerFrame={state.spinnerFrame} useStatic={false} />;
}

// Detect the terminal background BEFORE Ink takes over stdin, then render with
// the matching palette so the demo is readable on light and dark terminals.
const mode = await resolveThemeMode();
render(
  <ThemeProvider colors={getColors(mode)}>
    <App />
  </ThemeProvider>,
);
