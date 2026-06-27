import { Box, Static, Text } from 'ink';
import type { ReactElement } from 'react';
import type { ColorTier } from '../color.js';
import {
  eventGlyph,
  formatCents,
  formatElapsed,
  formatTokens,
  glyph,
  type Palette,
  type ThemeMode,
} from '../theme.js';
import { renderTodos } from '../rail-todos.js';
import type { ApprovalPrompt, Phase, PhaseEvent, RailModel } from '../rail-types.js';
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

export interface RunViewLabels {
  push?: string;
  noPush?: string;
  tasks?: string;
  /** Collapse-indicator template for the live tail, with a `{count}` placeholder. */
  earlier?: string;
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
  // foreground colour (italic), with no tool glyph. It reads like a sentence in
  // the conversation, distinct from the mechanical glyph+verb action lines.
  if (event.kind === 'narration') {
    return (
      <Box>
        {/* flexShrink=0 so the rail prefix keeps its full width when the prose
            wraps (otherwise Yoga steals a space and the wrapped line mis-aligns). */}
        <Box flexShrink={0}>
          <Text color={colors.rail}>{` ${glyph.railV}   `}</Text>
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
        : null}
    </Box>
  );
}

/** The current turn's prose as it streams in — typed out with a soft cursor. */
function StreamingNarration({ text, colors }: { text: string; colors: Palette }): ReactElement {
  return (
    <Box>
      <Box flexShrink={0}>
        <Text color={colors.rail}>{` ${glyph.railV}   `}</Text>
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
 * The interrupt composing line (INT-1): what the user is typing WHILE the run
 * streams. A distinct accent prompt (`›`) at the foot of the rail with a soft
 * cursor — so it reads as "you, mid-run" without disturbing the agent's prose
 * above. Rendered only while composing; ESC still cancels the run, Enter sends.
 */
function InterruptDraft({ text, colors }: { text: string; colors: Palette }): ReactElement {
  return (
    <Box marginTop={1}>
      <Box flexShrink={0}>
        <Text color={colors.accent} bold>{` › `}</Text>
      </Box>
      <Text color={colors.text} wrap="wrap">
        {text}
        <Text color={colors.muted}>▌</Text>
      </Text>
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
    // The metrics worth seeing mid-conversation: elapsed · tokens · cost. The
    // internal level/safety/push/model jargon stays out of the user's way.
    const metrics = [
      formatElapsed(s.elapsedMs),
      hasTokens ? `${formatTokens(s.inputTokens)}↑ ${formatTokens(s.outputTokens)}↓` : null,
      formatCents(s.costCents),
    ]
      .filter((part): part is string => part !== null && part.length > 0)
      .join(' · ');
    return (
      <Box flexDirection="column">
        <Text color={colors.rail}>{` ${'─'.repeat(48)}`}</Text>
        <Box>
          <Text>{'  '}</Text>
          <Text color={colors.muted}>{metrics}</Text>
          {doneMark}
          {errMark}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={colors.rail}>{` ${'─'.repeat(48)}`}</Text>
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
  const streamingNarration = props.streamingNarration ?? '';
  const interruptDraft = props.interruptDraft ?? '';
  const interruptNotice = props.interruptNotice ?? '';
  const compactStatus = props.compactStatus ?? false;

  const done = (phase: Phase): boolean => phase.state === 'completed' || phase.state === 'failed';
  const completed = model.phases.filter(done);
  const liveTail = model.phases.filter((phase) => !done(phase));
  const active = activeId(model.phases);

  const todoLines =
    model.todos !== undefined
      ? renderTodos(model.todos, {
          tier: tier ?? 'none',
          mode: mode ?? 'dark',
          ...(labels?.tasks !== undefined ? { label: labels.tasks } : {}),
        })
      : [];

  // Budget the most-recent diff to the rows the rest of the live (non-`<Static>`)
  // region does NOT already claim, so Ink's repaint never erases the scrollback
  // above it (RUN-FIX-7). We subtract the ACTUAL chrome — todos, streaming
  // narration (wrapped), each live phase header, the windowed event tail + its
  // "earlier" line, the status block, and any approval/interrupt rows — not a
  // constant, plus a small margin for an above-rail ribbon. Below a useful floor
  // the diff drops to its one-line stub rather than overflow.
  const narrationRows =
    streamingNarration.length > 0
      ? Math.max(1, Math.ceil(streamingNarration.length / Math.max(20, width - 6)))
      : 0;
  const liveChrome =
    2 + // status hairline + metrics line
    todoLines.length +
    narrationRows +
    liveTail.length + // each live phase node's header line
    (ACTIVE_EVENT_WINDOW + 1) + // up to N event rows + the "⋯ N earlier" line
    (approval !== null ? 2 : 0) +
    (interruptNotice.length > 0 ? 2 : 0) +
    (interruptDraft.length > 0 ? 2 : 0) +
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
        <StreamingNarration text={streamingNarration} colors={colors} />
      ) : null}
      {todoLines.length > 0 ? (
        <Box flexDirection="column">
          {todoLines.map((line, index) => (
            <Text key={index}>{line}</Text>
          ))}
        </Box>
      ) : null}
      {interruptNotice.length > 0 ? (
        <InterruptNotice text={interruptNotice} colors={colors} />
      ) : null}
      {approval !== null ? <ApprovalRow approval={approval} colors={colors} /> : null}
      {interruptDraft.length > 0 ? <InterruptDraft text={interruptDraft} colors={colors} /> : null}
      <StatusLine model={model} colors={colors} labels={labels} compact={compactStatus} />
    </Box>
  );
}
