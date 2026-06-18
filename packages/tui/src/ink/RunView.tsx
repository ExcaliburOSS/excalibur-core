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
import { useColors } from './ThemeContext.js';
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
  /** Route completed phases through `<Static>` (default true; off for tests). */
  useStatic?: boolean;
}

/** The trailing annotation: detail · duration · cost (cost only when ≥ 0.5¢). */
function annotationFor(phase: Phase): string {
  const parts: string[] = [];
  if (phase.detail !== undefined && phase.detail.length > 0) parts.push(phase.detail);
  if (phase.durationMs !== undefined) parts.push(formatElapsed(phase.durationMs));
  if (phase.costCents !== undefined && phase.costCents >= 0.5) parts.push(formatCents(phase.costCents));
  return parts.length > 0 ? `  ${parts.join(' · ')}` : '';
}

function EventRow({ event, colors }: { event: PhaseEvent; colors: Palette }): ReactElement {
  const tone = toneColor(event.tone, colors);
  const g = event.kind !== undefined ? eventGlyph[event.kind] : glyph.branch;
  return (
    <Box>
      <Text color={colors.rail}>{` ${glyph.railV}   `}</Text>
      <Text color={tone}>{`${g} `}</Text>
      <Text color={tone}>{event.text}</Text>
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
}: {
  phase: Phase;
  active: boolean;
  spinnerFrame: number;
  colors: Palette;
}): ReactElement {
  const node = stateGlyph(phase.state, spinnerFrame, colors);
  const annotation = annotationFor(phase);
  const paddedName = annotation.length > 0 ? phase.name.padEnd(NAME_WIDTH) : phase.name;
  const nameColor = active ? colors.text : colors.muted;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={node.color}>{` ${node.char} `}</Text>
        <Text color={nameColor} bold={active}>
          {paddedName}
        </Text>
        {annotation.length > 0 ? <Text color={colors.muted}>{annotation}</Text> : null}
      </Box>
      {active
        ? (phase.events ?? []).map((event, index) => (
            <EventRow key={index} event={event} colors={colors} />
          ))
        : null}
    </Box>
  );
}

function StatusLine({
  model,
  colors,
  labels,
}: {
  model: RailModel;
  colors: Palette;
  labels?: RunViewLabels;
}): ReactElement {
  const s = model.status;
  const hasTokens = s.inputTokens + s.outputTokens > 0;
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
        {model.done ? <Text color={colors.success} bold>{`  ${glyph.done} done`}</Text> : null}
        {model.errored ? <Text color={colors.danger} bold>{`  ${glyph.failed}`}</Text> : null}
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
  const { model, spinnerFrame, diffsExpanded, tier, mode, labels } = props;
  const useStatic = props.useStatic ?? true;
  const approval = props.approval ?? model.approval ?? null;
  void diffsExpanded; // consumed by <DiffView> in a later phase

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

  const renderPhase = (phase: Phase): ReactElement => (
    <PhaseNode
      key={phase.id}
      phase={phase}
      active={phase.id === active}
      spinnerFrame={spinnerFrame}
      colors={colors}
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
      {todoLines.length > 0 ? (
        <Box flexDirection="column">
          {todoLines.map((line, index) => (
            <Text key={index}>{line}</Text>
          ))}
        </Box>
      ) : null}
      {approval !== null ? <ApprovalRow approval={approval} colors={colors} /> : null}
      <StatusLine model={model} colors={colors} labels={labels} />
    </Box>
  );
}
