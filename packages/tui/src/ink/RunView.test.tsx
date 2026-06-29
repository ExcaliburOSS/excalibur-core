import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { render } from 'ink-testing-library';
import { createEvent } from '@excalibur/shared';
import { stripAnsi } from '../color.js';
import { darkColors } from '../theme.js';
import type { RailModel } from '../rail-types.js';
import { ThemeProvider } from './ThemeContext.js';
import { RunView } from './RunView.js';
import { DiffView } from './DiffView.js';
import { mountRunView } from './mount.js';
import { createLanesStore, mountLanesView } from './Lanes.js';
import { applyRunViewKey, createRunViewStore } from './store.js';

const SAMPLE_DIFF =
  'diff --git a/src/calc.ts b/src/calc.ts\n' +
  '--- a/src/calc.ts\n' +
  '+++ b/src/calc.ts\n' +
  '@@ -1 +1 @@\n' +
  '-export const total = 0;\n' +
  '+export const total: number = rate * amount;\n';

function model(overrides: Partial<RailModel> = {}): RailModel {
  return {
    runId: 'run_test',
    title: 'Fix duplicate escrow release',
    autonomyLabel: 'L3',
    phases: [
      { id: 'context', name: 'Context', state: 'completed', detail: 'read 6 files' },
      {
        id: 'implement',
        name: 'Implement',
        state: 'running',
        detail: 'escrow.service.ts',
        events: [{ text: 'edit escrow.service.ts', note: '+24 −6', tone: 'accent', kind: 'write' }],
      },
      { id: 'verify', name: 'Verify', state: 'pending' },
    ],
    status: {
      elapsedMs: 5000,
      costCents: 12,
      safety: 'standard-safe',
      push: false,
      model: 'kimi',
      inputTokens: 0,
      outputTokens: 0,
    },
    done: false,
    errored: false,
    ...overrides,
  };
}

/** Renders <RunView> inside a ThemeProvider; returns the stripped last frame. */
function frameOf(props: Parameters<typeof RunView>[0]): string {
  const { lastFrame } = render(
    <ThemeProvider colors={darkColors}>
      <RunView {...props} />
    </ThemeProvider>,
  );
  return stripAnsi(lastFrame() ?? '');
}

describe('<RunView>', () => {
  it('renders the phases, the active phase event stream and the status line', () => {
    const frame = frameOf({ model: model(), spinnerFrame: 0, useStatic: false });
    expect(frame).toContain('Context');
    expect(frame).toContain('Implement');
    expect(frame).toContain('Verify');
    expect(frame).toContain('edit escrow.service.ts');
    expect(frame).toContain('+24');
    // Status line: autonomy · safety · cost · elapsed · push · model.
    expect(frame).toContain('L3');
    expect(frame).toContain('standard-safe');
    expect(frame).toContain('kimi');
    expect(frame).toContain('no push');
  });

  it('compactStatus slims the footer to time · tokens · cost (drops level/safety/push/model)', () => {
    const frame = frameOf({
      model: model({
        status: {
          elapsedMs: 5000,
          costCents: 12,
          safety: 'standard-safe',
          push: false,
          model: 'kimi',
          inputTokens: 1200,
          outputTokens: 340,
        },
      }),
      spinnerFrame: 0,
      useStatic: false,
      compactStatus: true,
    });
    // Kept: the metrics worth seeing mid-conversation.
    expect(frame).toContain('↑');
    expect(frame).toContain('↓');
    // Dropped: the internal jargon.
    expect(frame).not.toContain('standard-safe');
    expect(frame).not.toContain('no push');
    expect(frame).not.toContain('L3');
    expect(frame).not.toContain('kimi');
  });

  it('renders an interactive approval (question + options)', () => {
    const frame = frameOf({
      model: model(),
      spinnerFrame: 0,
      useStatic: false,
      approval: { question: 'Approve write to escrow.service.ts?', options: '[y/N/always]' },
    });
    expect(frame).toContain('Approve write to escrow.service.ts?');
    expect(frame).toContain('[y/N/always]');
  });

  it('persists a resolved approval line under a COMPLETED phase, but drops the action tail (RUN-FIX-13)', () => {
    const frame = frameOf({
      model: model({
        phases: [
          {
            id: 'turn',
            name: 'Working',
            state: 'completed',
            events: [
              { text: 'read util.js', tone: 'muted', kind: 'read' },
              { text: 'edit util.js? → aprobado', tone: 'success', kind: 'approval' },
            ],
          },
        ],
        done: true,
      }),
      spinnerFrame: 0,
      useStatic: false,
    });
    // The transient action tail is dropped once the phase completes…
    expect(frame).not.toContain('read util.js');
    // …but the approval question + decision PERSISTS in scrollback.
    expect(frame).toContain('edit util.js? → aprobado');
  });

  it('shows a done marker when the run completed', () => {
    const phases = model().phases.map((p) => ({ ...p, state: 'completed' as const }));
    const frame = frameOf({
      model: model({ phases, done: true }),
      spinnerFrame: 0,
      useStatic: false,
    });
    expect(frame).toContain('done');
  });

  it('shows the failed glyph when the run errored', () => {
    const frame = frameOf({ model: model({ errored: true }), spinnerFrame: 0, useStatic: false });
    expect(frame).toContain('✗');
  });

  it('renders the todos band', () => {
    const frame = frameOf({
      model: model({
        todos: [
          { text: 'guard release() behind a table', status: 'completed' },
          { text: 'add idempotency key', status: 'in_progress' },
        ],
      }),
      spinnerFrame: 0,
      useStatic: false,
      tier: 'truecolor',
    });
    expect(frame).toContain('Tasks');
    expect(frame).toContain('guard release()');
    expect(frame).toContain('add idempotency key');
  });

  it('marks the IN-PROGRESS todo distinctly (running glyph) from completed/pending (RUN-FIX-17)', () => {
    // The band differentiates state so the active task reads as "happening now":
    // ◐ for in-progress (the breathing dot — its colour/shimmer move with the
    // spinner frame, covered by shimmer.test.ts / theme.test.ts), ✓ for done, ○ for
    // pending. The text is stable across frames (no jitter on what it's doing).
    const todos = [
      { text: 'guard release behind a table', status: 'completed' as const },
      { text: 'wire the idempotency key', status: 'in_progress' as const },
      { text: 'add a regression test', status: 'pending' as const },
    ];
    const frame0 = frameOf({
      model: model({ phases: [], todos }),
      spinnerFrame: 0,
      useStatic: false,
      tier: 'truecolor',
    });
    const frame3 = frameOf({
      model: model({ phases: [], todos }),
      spinnerFrame: 3,
      useStatic: false,
      tier: 'truecolor',
    });
    // 1/3 done in the header, and each state's glyph present.
    expect(frame0).toContain('1/3');
    expect(frame0).toContain('◐ wire the idempotency key'); // in-progress → running glyph
    expect(frame0).toContain('✓ guard release'); // completed → done glyph
    expect(frame0).toContain('○ add a regression test'); // pending → pending glyph
    // The rendered TEXT is stable across spinner ticks (only colour breathes).
    expect(frame3).toBe(frame0);
  });

  it('collapses the active phase to its most-recent tail with a "N earlier" indicator', () => {
    // 9 events on the running phase → only the last 5 show, behind a collapse
    // indicator, so the breathing phase header never scrolls off (RUN-FIX-2).
    const events = Array.from({ length: 9 }, (_, i) => ({
      text: `step number ${i}`,
      tone: 'muted' as const,
      kind: 'tool' as const,
    }));
    const frame = frameOf({
      model: model({
        phases: [{ id: 'impl', name: 'Implement', state: 'running', events }],
      }),
      spinnerFrame: 0,
      useStatic: false,
    });
    expect(frame).toContain('⋯ 4 earlier');
    expect(frame).toContain('step number 8'); // the most-recent (in-progress) action
    expect(frame).toContain('step number 4'); // first of the visible tail
    expect(frame).not.toContain('step number 0'); // collapsed away
    expect(frame).not.toContain('step number 3');
  });

  it('caps the default diff peek to the terminal height so it never eats the scrollback (RUN-FIX-7)', () => {
    const body = Array.from({ length: 40 }, (_, i) => `+bigline ${i}`).join('\n');
    const big = `diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -0,0 +1,40 @@\n${body}\n`;
    const writeModel = model({
      phases: [
        {
          id: 'impl',
          name: 'Implement',
          state: 'running',
          events: [{ text: 'write f.ts', tone: 'accent', kind: 'write', diff: big }],
        },
      ],
    });
    const countBody = (frame: string): number =>
      frame.split('\n').filter((l) => l.includes('bigline')).length;
    const short = countBody(
      frameOf({ model: writeModel, spinnerFrame: 0, useStatic: false, rows: 20 }),
    );
    const tall = countBody(
      frameOf({ model: writeModel, spinnerFrame: 0, useStatic: false, rows: 60 }),
    );
    // A short terminal shows fewer peeked lines than a tall one, and the peek is
    // always bounded (never the whole 40-line diff) — so the live region fits.
    expect(short).toBeGreaterThan(0);
    expect(short).toBeLessThan(tall);
    expect(tall).toBeLessThanOrEqual(25); // DEFAULT_PEEK_LINES ceiling
  });

  it('with <Static> on, the live region holds the active + pending tail (no crash)', () => {
    const { lastFrame, frames } = render(
      <ThemeProvider colors={darkColors}>
        <RunView model={model()} spinnerFrame={0} useStatic />
      </ThemeProvider>,
    );
    const live = stripAnsi(lastFrame() ?? '');
    expect(live).toContain('Implement');
    expect(live).toContain('Verify');
    // The completed phase was flushed once (it appears across the written frames).
    expect(stripAnsi(frames.join('\n'))).toContain('Context');
  });
});

describe('<DiffView>', () => {
  function diffFrame(props: Parameters<typeof DiffView>[0]): string {
    const { lastFrame } = render(
      <ThemeProvider colors={darkColors}>
        <DiffView {...props} />
      </ThemeProvider>,
    );
    return stripAnsi(lastFrame() ?? '');
  }

  it('collapsed: shows only an expand hint, not the diff body', () => {
    const frame = diffFrame({ diff: SAMPLE_DIFF, expanded: false, colors: darkColors });
    expect(frame).toContain('expand diff');
    expect(frame).not.toContain('rate * amount');
  });

  it('expanded: renders the diff body (added/removed lines)', () => {
    const frame = diffFrame({
      diff: SAMPLE_DIFF,
      expanded: true,
      colors: darkColors,
      tier: 'truecolor',
    });
    expect(frame).toContain('rate * amount');
    expect(frame).toContain('export const total');
  });

  it('renders nothing for an empty diff', () => {
    const frame = diffFrame({ diff: '', expanded: true, colors: darkColors });
    expect(frame.trim()).toBe('');
  });

  it('height-caps a long diff and summarises the remainder', () => {
    const body = Array.from({ length: 40 }, (_, i) => `+line ${i}`).join('\n');
    const big = `diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -0,0 +1,40 @@\n${body}\n`;
    const frame = diffFrame({ diff: big, expanded: true, colors: darkColors, maxLines: 8 });
    expect(frame).toContain('more lines');
  });

  it('stays UNIFIED (− then + stacked, left-aligned) even on a WIDE terminal (RUN-FIX-13)', () => {
    // On a wide terminal the old `auto` layout split into old|new columns, pairing
    // the − and + onto ONE row (deletions left, additions right). Unified keeps them
    // on SEPARATE, left-aligned rows. Guard: no single row carries both the del-only
    // text (`= 0;`) and the add-only text (`rate * amount`).
    const frame = diffFrame({ diff: SAMPLE_DIFF, expanded: true, colors: darkColors, width: 220 });
    const pairedRow = frame
      .split('\n')
      .some((r) => r.includes('= 0;') && r.includes('rate * amount'));
    expect(pairedRow).toBe(false);
    // Both versions remain present, just stacked.
    expect(frame).toContain('= 0;');
    expect(frame).toContain('rate * amount');
  });
});

describe('<RunView> inline diff', () => {
  it('shows the diff hint collapsed and the body when diffsExpanded', () => {
    const patchModel = model({
      phases: [
        {
          id: 'implement',
          name: 'Implement',
          state: 'running',
          events: [
            {
              text: 'patch generated',
              note: '+1 −1',
              tone: 'warn',
              kind: 'patch',
              diff: SAMPLE_DIFF,
            },
          ],
        },
      ],
    });
    // By default the most-recent change PEEKS its body (RUN-FIX-3) — the diff is
    // visible without pressing space, not hidden behind an "expand" stub.
    const collapsed = frameOf({ model: patchModel, spinnerFrame: 0, useStatic: false });
    expect(collapsed).toContain('rate * amount');

    const expanded = frameOf({
      model: patchModel,
      spinnerFrame: 0,
      useStatic: false,
      diffsExpanded: true,
      tier: 'truecolor',
    });
    expect(expanded).toContain('rate * amount');
  });

  it('streams the highlighted diff inline under a file_write line (AO6 Pillar 1)', () => {
    const writeModel = model({
      phases: [
        {
          id: 'implement',
          name: 'Implement',
          state: 'running',
          events: [
            {
              text: 'write src/calc.ts',
              note: '+1 −1 · 1 file',
              tone: 'accent',
              kind: 'write',
              diff: SAMPLE_DIFF,
            },
          ],
        },
      ],
    });
    // By default the latest change peeks its body right under the write line
    // (RUN-FIX-3) — visible without pressing space.
    const collapsed = frameOf({ model: writeModel, spinnerFrame: 0, useStatic: false });
    expect(collapsed).toContain('write src/calc.ts');
    expect(collapsed).toContain('rate * amount');
    // Space (diffsExpanded) keeps the highlighted body right under the write.
    const expanded = frameOf({
      model: writeModel,
      spinnerFrame: 0,
      useStatic: false,
      diffsExpanded: true,
      tier: 'truecolor',
    });
    expect(expanded).toContain('rate * amount');
  });
});

describe('createRunViewStore', () => {
  it('accumulates events, ticks the frame and toggles diffs', () => {
    const store = createRunViewStore();
    expect(store.getSnapshot().events).toHaveLength(0);
    store.push(createEvent({ runId: 'r', type: 'run_started', payload: {} }));
    expect(store.getSnapshot().events).toHaveLength(1);
    const before = store.getSnapshot().frame;
    store.tick();
    expect(store.getSnapshot().frame).toBe(before + 1);
    expect(store.getSnapshot().diffsExpanded).toBe(false);
    store.toggleDiffs();
    expect(store.getSnapshot().diffsExpanded).toBe(true);
  });

  it('pins a mission ribbon and resets the rail for a new capability (M8 #43)', () => {
    const store = createRunViewStore();
    expect(store.getSnapshot().missionRibbon).toBeNull();
    store.setRibbon({
      goal: 'g',
      steps: [
        { id: 'i', capability: 'implement', objective: 'do', status: 'running', gate: false },
      ],
    });
    expect(store.getSnapshot().missionRibbon?.goal).toBe('g');
    store.push(createEvent({ runId: 'r', type: 'file_write', payload: { path: 'a.ts' } }));
    expect(store.getSnapshot().events).toHaveLength(1);
    // A new capability resets the rail but KEEPS the ribbon pinned.
    store.resetEvents();
    expect(store.getSnapshot().events).toHaveLength(0);
    expect(store.getSnapshot().missionRibbon?.goal).toBe('g');
  });

  it('requestApproval resolves with the answer that resolveApproval supplies', async () => {
    const store = createRunViewStore();
    const promise = store.requestApproval({ question: 'Approve?', options: '[y/N]' });
    expect(store.getSnapshot().approval).not.toBeNull();
    store.resolveApproval('auto');
    await expect(promise).resolves.toBe('auto');
    expect(store.getSnapshot().approval).toBeNull();
  });

  it('settles a prior pending approval as "no" when a new one arrives (no orphaned hang)', async () => {
    const store = createRunViewStore();
    const first = store.requestApproval({ question: 'A?', options: '[y/N]' });
    const second = store.requestApproval({ question: 'B?', options: '[y/N]' });
    // The superseded approval resolves safely instead of hanging forever.
    await expect(first).resolves.toBe('no');
    store.resolveApproval('yes');
    await expect(second).resolves.toBe('yes');
  });

  it('fires registered escape handlers and unsubscribes', () => {
    const store = createRunViewStore();
    let fired = 0;
    const off = store.onEscape(() => {
      fired += 1;
    });
    store.fireEscape();
    off();
    store.fireEscape();
    expect(fired).toBe(1);
  });

  it('streams live narration and retires the buffer when the model_call lands', () => {
    const store = createRunViewStore();
    expect(store.getSnapshot().streamingNarration).toBe('');
    // Prose types out live, fragment by fragment.
    store.streamNarration('Let me');
    store.streamNarration('Let me read the file.');
    expect(store.getSnapshot().streamingNarration).toBe('Let me read the file.');
    // The turn's model_call commits that prose (the fold renders it) → buffer clears.
    store.push(
      createEvent({
        runId: 'r',
        type: 'model_call',
        payload: { content: 'Let me read the file.' },
      }),
    );
    expect(store.getSnapshot().streamingNarration).toBe('');
  });
});

describe('applyRunViewKey', () => {
  it('maps y/n/a/Return to the approval answer', async () => {
    for (const [input, expected] of [
      ['y', 'yes'],
      ['n', 'no'],
      ['a', 'auto'],
    ] as const) {
      const store = createRunViewStore();
      const promise = store.requestApproval({ question: 'Approve?', options: '[y/N/always]' });
      applyRunViewKey(store, input, {});
      await expect(promise).resolves.toBe(expected);
    }
    const store = createRunViewStore();
    const promise = store.requestApproval({ question: 'Approve?', options: '[y/N/always]' });
    applyRunViewKey(store, '', { return: true });
    await expect(promise).resolves.toBe('yes');
  });

  it('ESC fires escape; Space toggles diffs only when no approval is pending', () => {
    const store = createRunViewStore();
    let escaped = 0;
    store.onEscape(() => {
      escaped += 1;
    });
    applyRunViewKey(store, '', { escape: true });
    expect(escaped).toBe(1);
    applyRunViewKey(store, ' ', {});
    expect(store.getSnapshot().diffsExpanded).toBe(true);
  });
});

describe('interrupt channel (INT-1)', () => {
  it('is inert until a handler arms it — keystrokes are not captured into a draft', () => {
    const store = createRunViewStore();
    expect(store.getSnapshot().interruptEnabled).toBe(false);
    applyRunViewKey(store, 'h', {});
    applyRunViewKey(store, 'i', {});
    expect(store.getSnapshot().interruptDraft).toBe(''); // nowhere to deliver → not captured
    // Space keeps its legacy diff-toggle binding while unarmed.
    applyRunViewKey(store, ' ', {});
    expect(store.getSnapshot().diffsExpanded).toBe(true);
  });

  it('arming via onInterrupt enables capture; disarming on the last unsubscribe clears the draft', () => {
    const store = createRunViewStore();
    const off = store.onInterrupt(() => {});
    expect(store.getSnapshot().interruptEnabled).toBe(true);
    store.appendInterrupt('hey');
    expect(store.getSnapshot().interruptDraft).toBe('hey');
    off();
    expect(store.getSnapshot().interruptEnabled).toBe(false);
    expect(store.getSnapshot().interruptDraft).toBe(''); // disarm wipes the half-typed draft
  });

  it('types a draft, backspaces, and submits the trimmed text to the handler on Enter', () => {
    const store = createRunViewStore();
    const seen: string[] = [];
    store.onInterrupt((text) => seen.push(text));
    for (const ch of 'also add tests') applyRunViewKey(store, ch, {});
    expect(store.getSnapshot().interruptDraft).toBe('also add tests');
    applyRunViewKey(store, '', { backspace: true });
    expect(store.getSnapshot().interruptDraft).toBe('also add test');
    applyRunViewKey(store, '', { return: true });
    expect(seen).toEqual(['also add test']);
    expect(store.getSnapshot().interruptDraft).toBe(''); // cleared after submit
  });

  it('once composing, Space is a typed space — but toggles diffs while the draft is empty', () => {
    const store = createRunViewStore();
    store.onInterrupt(() => {});
    applyRunViewKey(store, ' ', {}); // empty draft → diff toggle
    expect(store.getSnapshot().diffsExpanded).toBe(true);
    expect(store.getSnapshot().interruptDraft).toBe('');
    applyRunViewKey(store, 'a', {});
    applyRunViewKey(store, ' ', {}); // now composing → real space
    applyRunViewKey(store, 'b', {});
    expect(store.getSnapshot().interruptDraft).toBe('a b');
  });

  it('ignores control/modifier keys and an empty submit; ESC still cancels mid-compose', () => {
    const store = createRunViewStore();
    let escaped = 0;
    const fired: string[] = [];
    store.onEscape(() => (escaped += 1));
    store.onInterrupt((t) => fired.push(t));
    applyRunViewKey(store, 'k', { ctrl: true }); // Ctrl-combo, not text (and not Ctrl-C)
    applyRunViewKey(store, '', { meta: true });
    expect(store.getSnapshot().interruptDraft).toBe('');
    applyRunViewKey(store, '', { return: true }); // blank submit → no-op
    expect(fired).toHaveLength(0);
    // Type, then ESC: cancels the run, does not submit the draft.
    applyRunViewKey(store, 'x', {});
    applyRunViewKey(store, '', { escape: true });
    expect(escaped).toBe(1);
    expect(fired).toHaveLength(0);
  });

  it('an approval gate still answers with y/n/a even while the channel is armed', async () => {
    const store = createRunViewStore();
    store.onInterrupt(() => {});
    const promise = store.requestApproval({ question: 'Approve?', options: '[y/N/a]' });
    applyRunViewKey(store, 'y', {});
    await expect(promise).resolves.toBe('yes');
    expect(store.getSnapshot().interruptDraft).toBe(''); // not captured as text
  });
});

// NOTE: the key→store contract is fully covered by `applyRunViewKey` above, and
// `<Keys>` (mount.tsx) is a one-line `useInput` forward to it. End-to-end RAW
// keystroke handling (raw mode + Ink's stdin parsing) is validated by the pty
// smoke in scripts/verify-real.mjs (phase 5 of the Ink migration).

/** A minimal fake stdout that collects every write (no real terminal). */
function fakeStdout(): NodeJS.WriteStream & { frames: string[] } {
  const out = new EventEmitter() as unknown as NodeJS.WriteStream & { frames: string[] };
  out.frames = [];
  out.columns = 80;
  out.rows = 24;
  out.write = ((chunk: string): boolean => {
    out.frames.push(String(chunk));
    return true;
  }) as NodeJS.WriteStream['write'];
  return out;
}

/** A non-TTY fake stdin (so the input guard stays inert — no raw mode). */
function fakeStdin(): NodeJS.ReadStream {
  const inp = new EventEmitter() as unknown as NodeJS.ReadStream;
  inp.isTTY = false;
  (inp as unknown as { setRawMode: () => void }).setRawMode = () => {};
  inp.ref = (() => inp) as NodeJS.ReadStream['ref'];
  inp.unref = (() => inp) as NodeJS.ReadStream['unref'];
  inp.read = (() => null) as NodeJS.ReadStream['read'];
  inp.setEncoding = (() => inp) as NodeJS.ReadStream['setEncoding'];
  inp.resume = (() => inp) as NodeJS.ReadStream['resume'];
  inp.pause = (() => inp) as NodeJS.ReadStream['pause'];
  return inp;
}

/**
 * Settles a mounted Ink view and returns the rendered text written to `stdout`.
 *
 * Ink renders differently under a CI environment (`is-in-ci`, captured at import
 * time): it *buffers* the dynamic (non-`<Static>`) frame and only writes it to
 * stdout on `unmount()` — so asserting on intermediate frames is empty on CI but
 * not on a dev box, which is exactly why a fixed-sleep assertion flaked. Reading
 * after `unmount()` is the one assertion point that holds in BOTH environments.
 * The awaited ticks first let React reconcile the pushed events/updates into
 * Ink's tree so the final frame reflects them.
 */
async function settleAndRead(
  handle: { unmount: () => void },
  stdout: { frames: string[] },
): Promise<string> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  handle.unmount();
  return stripAnsi(stdout.frames.join('\n'));
}

describe('createLanesStore', () => {
  it('transitions lanes empty → running → done/failed', () => {
    const store = createLanesStore([
      { id: 'a', title: 'Lane A' },
      { id: 'b', title: 'Lane B' },
    ]);
    expect(store.getSnapshot().model.lanes.map((l) => l.state)).toEqual(['empty', 'empty']);
    store.update({ index: 0, phase: 'started' });
    expect(store.getSnapshot().model.lanes[0]!.state).toBe('running');
    store.update({ index: 0, phase: 'settled' });
    expect(store.getSnapshot().model.lanes[0]!.state).toBe('done');
    store.update({ index: 1, phase: 'settled', failed: true });
    expect(store.getSnapshot().model.lanes[1]!.state).toBe('failed');
  });
});

describe('mountLanesView', () => {
  it('renders live lane progress then the final panel to its stdout', async () => {
    const stdout = fakeStdout();
    const handle = mountLanesView({
      palette: darkColors,
      tier: 'truecolor',
      lanes: [
        { id: 'a', title: 'Lane A' },
        { id: 'b', title: 'Lane B' },
      ],
      stdout,
      stdin: fakeStdin(),
    });
    handle.update({ index: 0, phase: 'started' });
    handle.update({ index: 0, phase: 'settled' });
    handle.setFinal({
      lanes: [
        { id: 'a', title: 'Lane A', state: 'done' },
        { id: 'b', title: 'Lane B', state: 'done' },
      ],
      applied: 2,
      conflicts: 0,
    });
    const out = await settleAndRead(handle, stdout);
    expect(out).toContain('Lane A');
    expect(out).toContain('Lane B');
  });
});

describe('mountRunView', () => {
  it('renders pushed events to its stdout and unmounts cleanly (non-TTY safe)', async () => {
    const stdout = fakeStdout();
    const handle = mountRunView({
      palette: darkColors,
      tier: 'truecolor',
      reduce: { autonomyLabel: 'L3', safety: 'standard-safe', model: 'kimi' },
      now: () => 1000,
      tickMs: 0,
      stdout,
      stdin: fakeStdin(),
    });
    handle.push(createEvent({ runId: 'r', type: 'run_started', payload: { title: 'Test run' } }));
    const out = await settleAndRead(handle, stdout);
    expect(out).toContain('kimi');
    expect(out).toContain('standard-safe');
  });
});
