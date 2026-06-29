import { Box, Static, Text } from 'ink';
import type { ReactElement } from 'react';
import type { ColorTier } from '../color.js';
import {
  eventGlyph,
  formatCents,
  formatElapsed,
  formatTokens,
  glyph,
  pulseColor,
  pulseGlyph,
  type Palette,
  type ThemeMode,
} from '../theme.js';
import type { ApprovalPrompt, Phase, PhaseEvent, RailModel, TodoItem } from '../rail-types.js';
import { windowActiveEvents, formatEarlier, ACTIVE_EVENT_WINDOW } from '../rail-window.js';
import { shimmerSpans } from '../shimmer.js';
import { useColors } from './ThemeContext.js';
import { DiffView, DEFAULT_PEEK_LINES } from './DiffView.js';
import { stateGlyph, toneColor } from './phase-style.js';

/**
 * `<RunView>` — the live Ink presenter of a {@link RailModel} (the M-Shell rail).
 *
 * The SAME `reduceRail` fold drives this and the pure `renderRail` string
 * presenter, so the TTY and non-TTY views stay consistent; this component just
 * renders the model with Ink primitives (and, unlike the string form, hosts the
 * inline diff + interactive approval).
 *
 * Terminal phases (completed/failed) go into Ink's `<Static>` — printed ONCE,
 * above the live region, into natural scrollback — so Ink's full-region repaint
 * stays small and the rail does not flicker as a long run grows. The active +
 * pending tail, todos, approval and the pinned status line make up the live
 * region. `useStatic` can be disabled (deterministic full-frame snapshots).
 */

const NAME_WIDTH = 18;

/** Max todo ITEM rows the live band renders before it windows the rest (RUN-FIX-20). */
const MAX_TODO_ITEMS = 6;

/** Max wrapped rows the live streaming-narration tail may occupy (RUN-FIX-20). */
const MAX_NARRATION_ROWS = 4;

/**
 * Window a todo list so the band never grows past a few rows (else the live region
 * scrolls over the `<Static>` scrollback and erases history — RUN-FIX-20). Anchors on
 * the in-progress item so it is always visible, collapses the completed prefix into a
 * "⋯ N done" line and any pending overflow into a trailing "⋯ N more". Non-TTY logs
 * keep the FULL list via the string `renderTodos`.
 */
function todoWindow(
  todos: ReadonlyArray<TodoItem>,
  maxItems: number,
): { items: ReadonlyArray<TodoItem>; hidden: number; more: number } {
  if (todos.length <= maxItems) {
    return { items: todos, hidden: 0, more: 0 };
  }
  const ip = todos.findIndex((todo) => todo.status === 'in_progress');
  const firstActive = todos.findIndex((todo) => todo.status !== 'completed');
  const anchor = ip >= 0 ? ip : firstActive >= 0 ? firstActive : todos.length - 1;
  // Keep one item of context before the anchor, then fill forward; clamp to bounds.
  const start = Math.max(0, Math.min(anchor - 1, todos.length - maxItems));
  const items = todos.slice(start, start + maxItems);
  return { items, hidden: start, more: todos.length - (start + items.length) };
}

export interface RunViewLabels {
  push?: string;
  noPush?: string;
  tasks?: string;
  /** Collapse-indicator template for the live tail, with a `{count}` placeholder. */
  earlier?: string;
  /** Dim hint shown in the persistent mid-run input prompt when it's empty. */
  interruptHint?: string;
}

export interface RunViewProps {
  model: RailModel;
  spinnerFrame: number;
  /** The interactive approval to show (store-driven), else the model's own. */
  approval?: ApprovalPrompt | null;
  diffsExpanded?: boolean;
  tier?: ColorTier;
  mode?: ThemeMode;
  labels?: RunViewLabels;
  /** Terminal columns, for width-adaptive inline diffs (default 80). */
  width?: number;
  /**
   * Terminal rows (default 24). The live (non-`<Static>`) region is height-capped
   * to fit within them: if Ink's dynamic output grows TALLER than the screen, its
   * repaint erases up into the scrollback above it — wiping earlier output. The
   * active-phase window + a rows-aware diff peek keep the live region on-screen.
   */
  rows?: number;
  /** Route completed phases through `<Static>` (default true; off for tests). */
  useStatic?: boolean;
  /** The current turn's prose as it streams in (typed out live), or ''. */
  streamingNarration?: string;
  /** The interrupt message the user is composing WHILE the run streams (INT-1), or ''. */
  interruptDraft?: string;
  /**
   * Whether the typing channel is ARMED (a handler is wired). When true the rail
   * shows a PERSISTENT input prompt at its foot so the user's input never visually
   * disappears mid-run — they can always type to steer/add/ask (RUN-FIX-17).
   */
  interruptEnabled?: boolean;
  /** The instant acknowledgment line after an interrupt is routed (INT-1), or ''. */
  interruptNotice?: string;
  /**
   * Slim the telemetry footer to just time · tokens · cost, dropping the internal
   * level/safety/push/model jargon. The conversational m-shell sets this;
   * `excalibur run`/`patch` leave it off to keep the full status footer.
   */
  compactStatus?: boolean;
}

/** The trailing annotation: detail · duration · cost (cost only when ≥ 0.5¢). */
function annotationFor(phase: Phase): string {
  const parts: string[] = [];
  if (phase.detail !== undefined && phase.detail.length > 0) parts.push(phase.detail);
  if (phase.durationMs !== undefined) parts.push(formatElapsed(phase.durationMs));
  if (phase.costCents !== undefined && phase.costCents >= 0.5)
    parts.push(formatCents(phase.costCents));
  return parts.length > 0 ? `  ${parts.join(' · ')}` : '';
}

function EventRow({
  event,
  colors,
  shimmer = false,
  spinnerFrame = 0,
}: {
  event: PhaseEvent;
  colors: Palette;
  /** Sweep a live accent crest across the text — the in-progress action (RUN-FIX-2). */
  shimmer?: boolean;
  spinnerFrame?: number;
}): ReactElement {
  // Narration is the agent TALKING to the user — flowing, wrapped prose in the
  // foreground colour (italic), led by Excalibur's signature accent ● so each
  // spoken paragraph reads as its own "bubble", distinct from the mechanical
  // glyph+verb action lines. A blank line above gives every utterance air, so a
  // turn breathes (space + rhythm) instead of stacking line-on-line.
  if (event.kind === 'narration') {
    return (
      <Box marginTop={1}>
        {/* flexShrink=0 so the marker keeps its full width when the prose wraps
            (otherwise Yoga steals a space and the wrapped line mis-aligns). */}
        <Box flexShrink={0}>
          <Text color={colors.accent} bold>{` ${pulseGlyph}   `}</Text>
        </Box>
        <Text color={colors.text} italic wrap="wrap">
          {event.text}
        </Text>
      </Box>
    );
  }
  const tone = toneColor(event.tone, colors);
  const g = event.kind !== undefined ? eventGlyph[event.kind] : glyph.branch;
  return (
    <Box>
      <Text color={colors.rail}>{` ${glyph.railV}   `}</Text>
      <Text color={tone}>{`${g} `}</Text>
      {shimmer ? (
        // Nested <Text> spans keep the line one wrapping run while each segment
        // carries its own colour — the crest that travels across it each tick.
        <Text>
          {shimmerSpans(event.text, spinnerFrame, colors, tone).map((span, index) => (
            <Text key={index} color={span.hex}>
              {span.text}
            </Text>
          ))}
        </Text>
      ) : (
        <Text color={tone}>{event.text}</Text>
      )}
      {event.note !== undefined && event.note.length > 0 ? (
        <Text color={colors.muted}>{`  ${event.note}`}</Text>
      ) : null}
    </Box>
  );
}

function PhaseNode({
  phase,
  active,
  spinnerFrame,
  colors,
  diffsExpanded,
  tier,
  mode,
  width,
  diffBudget,
  earlierLabel,
}: {
  phase: Phase;
  active: boolean;
  spinnerFrame: number;
  colors: Palette;
  diffsExpanded: boolean;
  tier?: ColorTier;
  mode?: ThemeMode;
  width: number;
  /** Max lines the most-recent diff may occupy — rows-aware so the live region
   * never exceeds the viewport (RUN-FIX-7); 0 falls back to the one-line stub. */
  diffBudget: number;
  /** Localized "⋯ {count} earlier" template for the collapse indicator. */
  earlierLabel?: string;
}): ReactElement {
  const node = stateGlyph(phase.state, spinnerFrame, colors);
  const annotation = annotationFor(phase);
  const paddedName = annotation.length > 0 ? phase.name.padEnd(NAME_WIDTH) : phase.name;
  const nameColor = active ? colors.text : colors.muted;

  // The active phase shows only its most-recent tail, so the header (the breathing
  // "Working…" node) never scrolls off as actions pile up (RUN-FIX-2).
  const allEvents = phase.events ?? [];
  const windowed = active
    ? windowActiveEvents(allEvents)
    : { hidden: 0, events: allEvents, offset: 0 };
  const evs = windowed.events;
  // The most-recent change with a diff peeks its body by default; older diffs in
  // the tail stay summarised by the `+N −M` note on their row (RUN-FIX-3).
  let lastDiffIdx = -1;
  for (let i = evs.length - 1; i >= 0; i -= 1) {
    if ((evs[i]!.diff ?? '').length > 0) {
      lastDiffIdx = i;
      break;
    }
  }
  // The in-progress action is the last event while the phase is genuinely running.
  const inProgressIdx = active && phase.state === 'running' && evs.length > 0 ? evs.length - 1 : -1;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={node.color}>{` ${node.char} `}</Text>
        {active && phase.state === 'running' ? (
          // The live phase title pulses an accent crest left→right (RUN-FIX-9) —
          // so the header itself reads as "happening now", not a static label.
          <Text bold>
            {shimmerSpans(paddedName, spinnerFrame, colors, colors.text).map((span, index) => (
              <Text key={index} color={span.hex}>
                {span.text}
              </Text>
            ))}
          </Text>
        ) : (
          <Text color={nameColor} bold={active}>
            {paddedName}
          </Text>
        )}
        {annotation.length > 0 ? <Text color={colors.muted}>{annotation}</Text> : null}
      </Box>
      {active && windowed.hidden > 0 ? (
        <Box>
          <Text color={colors.rail}>{` ${glyph.railV}   `}</Text>
          <Text color={colors.muted}>{formatEarlier(windowed.hidden, earlierLabel)}</Text>
        </Box>
      ) : null}
      {active
        ? evs.map((event, index) => {
            // Only the MOST-RECENT change renders its body inline (collapsed peek
            // OR expanded), both bounded by `diffBudget`, so neither the peek nor a
            // Space-expand can grow the live region past the viewport. Older diffs
            // keep just their `+N −M` note on the row.
            const isLatestDiff = (event.diff ?? '').length > 0 && index === lastDiffIdx;
            const peek =
              !diffsExpanded && diffBudget > 0
                ? Math.min(DEFAULT_PEEK_LINES, diffBudget)
                : undefined;
            const shimmer = index === inProgressIdx && event.kind !== 'narration';
            return (
              <Box key={windowed.offset + index} flexDirection="column">
                <EventRow
                  event={event}
                  colors={colors}
                  shimmer={shimmer}
                  spinnerFrame={spinnerFrame}
                />
                {isLatestDiff ? (
                  <DiffView
                    diff={event.diff ?? ''}
                    expanded={diffsExpanded}
                    colors={colors}
                    width={width}
                    maxLines={diffBudget}
                    {...(peek !== undefined ? { peek } : {})}
                    {...(tier !== undefined ? { tier } : {})}
                    {...(mode !== undefined ? { mode } : {})}
                  />
                ) : null}
              </Box>
            );
          })
        : // A COMPLETED phase keeps only its header in <Static> scrollback — the
          // transient action tail (reads/writes/narration) is intentionally dropped.
          // EXCEPT resolved approvals: the question + the user's decision PERSIST, so
          // the conversation keeps a permanent "you were asked X, you answered Y" record.
          (phase.events ?? [])
            .filter((event) => event.kind === 'approval')
            .map((event, index) => (
              <EventRow key={`approval-${index}`} event={event} colors={colors} />
            ))}
    </Box>
  );
}

/**
 * The current turn's prose as it streams in — typed out with a soft cursor, led
 * by a PULSING accent ● (Excalibur's "speaking now" beat, breathing along the
 * accent ramp via `spinnerFrame`) and floated on a blank line so the live
 * utterance stands clear of whatever came before it.
 */
function StreamingNarration({
  text,
  colors,
  spinnerFrame,
}: {
  text: string;
  colors: Palette;
  spinnerFrame: number;
}): ReactElement {
  return (
    <Box marginTop={1}>
      <Box flexShrink={0}>
        <Text color={pulseColor(colors, spinnerFrame)} bold>{` ${pulseGlyph}   `}</Text>
      </Box>
      {/* The cursor lives INSIDE the wrapping text so it follows the last
          character onto the final wrapped line, not the end of the first row. */}
      <Text color={colors.text} italic wrap="wrap">
        {text}
        <Text color={colors.muted}>▌</Text>
      </Text>
    </Box>
  );
}

/**
 * The mid-run input box (INT-1 / RUN-FIX-17 + 19): a PERSISTENT framed prompt at the
 * foot of the rail while the run streams, drawn to MATCH the idle input box exactly
 * (RUN-FIX-11) so the user's input never disappears AND looks identical to the normal
 * prompt: a full-width accent rule ABOVE and BELOW, the `›` prompt with a BREATHING
 * cursor inside (pulses along the accent ramp), and the `◆ autonomy · permissions`
 * indicator row beneath. When idle it shows a dim invitation; as the user types it
 * fills with their draft. Enter submits to the interrupt brain; ESC stops the run.
 */
function InterruptBox({
  text,
  colors,
  spinnerFrame,
  width,
  autonomyLabel,
  safety,
  placeholder,
}: {
  text: string;
  colors: Palette;
  spinnerFrame: number;
  width: number;
  autonomyLabel: string;
  safety: string;
  placeholder?: string;
}): ReactElement {
  // The SAME full-width accent rule the idle box uses to bracket the input.
  const rule = glyph.boxH.repeat(Math.max(8, width));
  // The cursor BREATHES along the accent ramp — an active, live caret, not a static block.
  const cursor = <Text color={pulseColor(colors, spinnerFrame)}>▌</Text>;
  // The indicator row under the box: ◆ autonomy · permissions (mirrors buildInputFooter).
  const left =
    autonomyLabel.length > 0 && safety.length > 0
      ? `${autonomyLabel} · ${safety}`
      : autonomyLabel || safety;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={colors.accent}>{rule}</Text>
      <Box>
        <Box flexShrink={0}>
          <Text color={colors.accent} bold>{` › `}</Text>
        </Box>
        {text.length > 0 ? (
          <Text color={colors.text} wrap="wrap">
            {text}
            {cursor}
          </Text>
        ) : (
          // Idle: a dim invitation so the input is visibly ALWAYS there, never gone.
          <Text color={colors.muted}>
            {placeholder !== undefined && placeholder.length > 0 ? `${placeholder} ` : ''}
            {cursor}
          </Text>
        )}
      </Box>
      <Text color={colors.accent}>{rule}</Text>
      {left.length > 0 ? (
        <Box>
          <Text>{'  '}</Text>
          <Text color={colors.accent}>{`${glyph.diamond} `}</Text>
          <Text color={colors.text}>{left}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** The instant acknowledgment after an interrupt is routed (INT-1) — a quiet, accented line. */
function InterruptNotice({ text, colors }: { text: string; colors: Palette }): ReactElement {
  return (
    <Box marginTop={1}>
      <Box flexShrink={0}>
        <Text color={colors.rail}>{` ${glyph.railV}   `}</Text>
      </Box>
      <Text color={colors.accent} wrap="wrap">
        {text}
      </Text>
    </Box>
  );
}

/**
 * The live checklist band (`task_update`). The IN-PROGRESS item BREATHES — its glyph
 * pulses along the accent ramp and a light crest sweeps left→right across its text
 * (shimmer) — so the user feels movement on what's actually happening right now
 * (RUN-FIX-17), matching the active-phase header. Completed/pending items are static.
 * The pure-string `renderTodos` still drives the non-TTY rail / logs / replay.
 */
function TodosBand({
  todos,
  spinnerFrame,
  colors,
  label,
  maxItems = MAX_TODO_ITEMS,
}: {
  todos: ReadonlyArray<TodoItem>;
  spinnerFrame: number;
  colors: Palette;
  label?: string;
  /** Max ITEM rows to render (excl. header + the collapse line); windows the rest. */
  maxItems?: number;
}): ReactElement {
  const done = todos.filter((todo) => todo.status === 'completed').length;
  // WINDOW the band so it can never grow taller than its budget and scroll the live
  // region over the <Static> scrollback (RUN-FIX-20). Collapse the COMPLETED prefix
  // into a "⋯ N done" line and show the active + pending tail (the actionable items).
  const window = todoWindow(todos, maxItems);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={colors.accent}>{` ${glyph.logo} `}</Text>
        <Text color={colors.text}>{label ?? 'Tasks'}</Text>
        <Text color={colors.muted}>{`  ${done}/${todos.length}`}</Text>
      </Box>
      {window.hidden > 0 ? (
        <Box>
          <Text color={colors.rail}>{` ${glyph.railV}   `}</Text>
          <Text color={colors.muted}>{`⋯ ${window.hidden} done`}</Text>
        </Box>
      ) : null}
      {window.items.map((todo, index) => {
        const active = todo.status === 'in_progress';
        const gch =
          todo.status === 'completed' ? glyph.done : active ? glyph.running : glyph.pending;
        const gColor =
          todo.status === 'completed'
            ? colors.success
            : active
              ? pulseColor(colors, spinnerFrame) // the breathing dot
              : colors.muted;
        return (
          <Box key={index}>
            <Box flexShrink={0}>
              <Text color={colors.rail}>{` ${glyph.railV}   `}</Text>
              <Text color={gColor}>{`${gch} `}</Text>
            </Box>
            {active ? (
              // Left→right light crest across the active task's text.
              <Text wrap="truncate-end">
                {shimmerSpans(todo.text, spinnerFrame, colors, colors.text).map((span, i) => (
                  <Text key={i} color={span.hex}>
                    {span.text}
                  </Text>
                ))}
              </Text>
            ) : (
              <Text color={colors.muted} wrap="truncate-end">
                {todo.text}
              </Text>
            )}
          </Box>
        );
      })}
      {window.more > 0 ? (
        <Box>
          <Text color={colors.rail}>{` ${glyph.railV}   `}</Text>
          <Text color={colors.muted}>{`⋯ ${window.more} more`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function StatusLine({
  model,
  colors,
  labels,
  compact,
}: {
  model: RailModel;
  colors: Palette;
  labels?: RunViewLabels;
  /** Conversational shell: show only time · tokens · cost (drop level/safety/push/model). */
  compact?: boolean;
}): ReactElement {
  const s = model.status;
  const hasTokens = s.inputTokens + s.outputTokens > 0;
  const doneMark = model.done ? (
    <Text color={colors.success} bold>{`  ${glyph.done} done`}</Text>
  ) : null;
  const errMark = model.errored ? (
    <Text color={colors.danger} bold>{`  ${glyph.failed}`}</Text>
  ) : null;

  if (compact === true) {
    // The metrics worth seeing mid-conversation: elapsed · tokens. Cost is dropped —
    // it is noise on the local/free paths (effectively always $0.00); the level/
    // safety/push/model jargon also stays out of the user's way.
    const metrics = [
      formatElapsed(s.elapsedMs),
      hasTokens ? `${formatTokens(s.inputTokens)}↑ ${formatTokens(s.outputTokens)}↓` : null,
    ]
      .filter((part): part is string => part !== null && part.length > 0)
      .join(' · ');
    return (
      <Box>
        <Text>{'  '}</Text>
        <Text color={colors.muted}>{metrics}</Text>
        {doneMark}
        {errMark}
      </Box>
    );
  }

  return (
    <Box>
      <Text>{'  '}</Text>
      {model.autonomyLabel.length > 0 ? (
        <Text color={colors.accent}>{`${model.autonomyLabel} · `}</Text>
      ) : null}
      <Text color={colors.muted}>{`${s.safety} · ${formatCents(s.costCents)} · `}</Text>
      {hasTokens ? (
        <Text color={colors.muted}>
          {`${formatTokens(s.inputTokens)}↑ ${formatTokens(s.outputTokens)}↓ · `}
        </Text>
      ) : null}
      <Text color={colors.muted}>
        {`${formatElapsed(s.elapsedMs)} · ${s.push ? (labels?.push ?? 'push') : (labels?.noPush ?? 'no push')} · `}
      </Text>
      <Text color={colors.accent}>{s.model}</Text>
      {doneMark}
      {errMark}
    </Box>
  );
}

function ApprovalRow({
  approval,
  colors,
}: {
  approval: ApprovalPrompt;
  colors: Palette;
}): ReactElement {
  return (
    <Box marginTop={1}>
      <Text color={colors.warn}>{` ${glyph.waiting} `}</Text>
      <Text color={colors.text}>{approval.question}</Text>
      <Text color={colors.warn} bold>{`   ${approval.options}`}</Text>
    </Box>
  );
}

/** Index of the last running/waiting phase (the active one whose events expand). */
function activeId(phases: ReadonlyArray<Phase>): string | null {
  for (let i = phases.length - 1; i >= 0; i -= 1) {
    const phase = phases[i]!;
    if (phase.state === 'running' || phase.state === 'waiting') {
      return phase.id;
    }
  }
  return null;
}

export function RunView(props: RunViewProps): ReactElement {
  const colors = useColors();
  const { model, spinnerFrame, tier, mode, labels } = props;
  const useStatic = props.useStatic ?? true;
  const diffsExpanded = props.diffsExpanded ?? false;
  const width = props.width ?? 80;
  const rows = props.rows ?? 24;
  const approval = props.approval ?? model.approval ?? null;
  const streamingNarrationFull = props.streamingNarration ?? '';
  const interruptDraft = props.interruptDraft ?? '';
  const interruptEnabled = props.interruptEnabled ?? false;
  const interruptNotice = props.interruptNotice ?? '';
  const compactStatus = props.compactStatus ?? false;

  const done = (phase: Phase): boolean => phase.state === 'completed' || phase.state === 'failed';
  const completed = model.phases.filter(done);
  const liveTail = model.phases.filter((phase) => !done(phase));
  const active = activeId(model.phases);

  // Row count the live checklist band claims — header + windowed items (+ up to two
  // "⋯ N done"/"⋯ N more" collapse lines). WINDOWED (RUN-FIX-20) so a long todo list
  // can never grow the live region past the viewport and erase scrollback; the matching
  // render is TodosBand/todoWindow. `renderTodos` (string) keeps the FULL list non-TTY.
  const todos = model.todos ?? [];
  const todoRows =
    todos.length > 0
      ? 1 + Math.min(todos.length, MAX_TODO_ITEMS) + (todos.length > MAX_TODO_ITEMS ? 2 : 0)
      : 0;

  // Budget the most-recent diff to the rows the rest of the live (non-`<Static>`)
  // region does NOT already claim, so Ink's repaint never erases the scrollback
  // above it (RUN-FIX-7). We subtract the ACTUAL chrome — todos, streaming
  // narration (wrapped), each live phase header, the windowed event tail + its
  // "earlier" line, the status block, and any approval/interrupt rows — not a
  // constant, plus a small margin for an above-rail ribbon. Below a useful floor
  // the diff drops to its one-line stub rather than overflow.
  // Streaming narration wraps + floats on a marginTop blank line. Clamp it to a TAIL
  // of MAX_NARRATION_ROWS so a long streamed paragraph can't grow the live region
  // unbounded and erase scrollback (RUN-FIX-20); the user always sees the latest prose.
  const narrationCols = Math.max(20, width - 6);
  const narrationCap = MAX_NARRATION_ROWS * narrationCols;
  const streamingNarration =
    streamingNarrationFull.length > narrationCap
      ? `…${streamingNarrationFull.slice(-narrationCap)}`
      : streamingNarrationFull;
  const narrationRows =
    streamingNarration.length > 0
      ? Math.min(
          MAX_NARRATION_ROWS,
          1 + Math.max(1, Math.ceil(streamingNarration.length / narrationCols)),
        )
      : 0;
  // The persistent mid-run input box (RUN-FIX-19): blank + top rule + prompt + bottom
  // rule + the ◆ indicator row. The prompt itself WRAPS, so count its wrapped height
  // (width-aware) instead of a flat 5, or a long typed draft undercounts and overflows.
  const interruptShown = interruptEnabled || interruptDraft.length > 0;
  const interruptRows = interruptShown
    ? 4 + Math.max(1, Math.ceil((interruptDraft.length + 1) / Math.max(8, width - 3)))
    : 0;
  const liveChrome =
    1 + // the single metrics line (no hairline rule above it anymore)
    todoRows +
    narrationRows +
    liveTail.length + // each live phase node's header line
    (ACTIVE_EVENT_WINDOW + 1) + // up to N event rows + the "⋯ N earlier" line
    (approval !== null ? 2 : 0) +
    (interruptNotice.length > 0 ? 2 : 0) +
    interruptRows +
    2; // headroom (above-rail ribbon / safety)
  const diffBudget = Math.max(0, rows - liveChrome);

  const renderPhase = (phase: Phase): ReactElement => (
    <PhaseNode
      key={phase.id}
      phase={phase}
      active={phase.id === active}
      spinnerFrame={spinnerFrame}
      colors={colors}
      diffsExpanded={diffsExpanded}
      width={width}
      diffBudget={diffBudget}
      {...(tier !== undefined ? { tier } : {})}
      {...(mode !== undefined ? { mode } : {})}
      {...(labels?.earlier !== undefined ? { earlierLabel: labels.earlier } : {})}
    />
  );

  return (
    <Box flexDirection="column">
      {useStatic ? (
        <Static items={completed}>{(phase) => renderPhase(phase)}</Static>
      ) : (
        completed.map(renderPhase)
      )}
      {liveTail.map(renderPhase)}
      {streamingNarration.length > 0 ? (
        <StreamingNarration text={streamingNarration} colors={colors} spinnerFrame={spinnerFrame} />
      ) : null}
      {todos.length > 0 ? (
        <TodosBand
          todos={todos}
          spinnerFrame={spinnerFrame}
          colors={colors}
          {...(labels?.tasks !== undefined ? { label: labels.tasks } : {})}
        />
      ) : null}
      {interruptNotice.length > 0 ? (
        <InterruptNotice text={interruptNotice} colors={colors} />
      ) : null}
      {approval !== null ? <ApprovalRow approval={approval} colors={colors} /> : null}
      {interruptEnabled || interruptDraft.length > 0 ? (
        <InterruptBox
          text={interruptDraft}
          colors={colors}
          spinnerFrame={spinnerFrame}
          width={width}
          autonomyLabel={model.autonomyLabel}
          safety={model.status.safety}
          {...(labels?.interruptHint !== undefined ? { placeholder: labels.interruptHint } : {})}
        />
      ) : null}
      <StatusLine model={model} colors={colors} labels={labels} compact={compactStatus} />
    </Box>
  );
}
