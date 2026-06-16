import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { glyph, eventGlyph, spinnerFrames, formatCents, formatElapsed, type Palette } from '../theme.js';
import { useColors } from '../ThemeContext.js';

/**
 * `<PhaseTimeline>` — the live run visualization (M-Shell seed).
 *
 * A vertical timeline whose rail fills as phases complete, with the active
 * phase expanded to show its event stream and an inline approval prompt when a
 * phase is gated. Driven entirely by props, so the same component renders a mock
 * demo or a real run streamed from `ExcaliburEvent`s. Colours come from the
 * active theme (auto light/dark), so it stays readable on any terminal.
 */

export type {
  PhaseState,
  PhaseEvent,
  Phase,
  ApprovalPrompt,
  RunStatus,
} from '../rail-types.js';
import type { ApprovalPrompt, Phase, PhaseEvent, PhaseState, RunStatus } from '../rail-types.js';

export interface PhaseTimelineProps {
  runId: string;
  title: string;
  autonomyLabel: string;
  phases: Phase[];
  status: RunStatus;
  spinnerFrame: number;
  approval?: ApprovalPrompt;
  done?: boolean;
}

function stateGlyph(
  state: PhaseState,
  spinnerFrame: number,
  colors: Palette,
): { char: string; color: string } {
  switch (state) {
    case 'completed':
      return { char: glyph.done, color: colors.success };
    case 'running':
      return {
        char: spinnerFrames[spinnerFrame % spinnerFrames.length] ?? glyph.running,
        color: colors.accent,
      };
    case 'waiting':
      return { char: glyph.waiting, color: colors.warn };
    case 'failed':
      return { char: glyph.failed, color: colors.danger };
    case 'pending':
    default:
      return { char: glyph.pending, color: colors.muted };
  }
}

function toneColor(tone: PhaseEvent['tone'], colors: Palette): string {
  switch (tone) {
    case 'accent':
      return colors.accent;
    case 'success':
      return colors.success;
    case 'warn':
      return colors.warn;
    case 'muted':
    default:
      return colors.muted;
  }
}

function PhaseRow({
  phase,
  isLast,
  spinnerFrame,
  colors,
}: {
  phase: Phase;
  isLast: boolean;
  spinnerFrame: number;
  colors: Palette;
}): ReactElement {
  const node = stateGlyph(phase.state, spinnerFrame, colors);
  const active = phase.state === 'running' || phase.state === 'waiting';
  const railColor = phase.state === 'completed' ? colors.success : colors.rail;
  const nameColor = phase.state === 'pending' ? colors.muted : colors.text;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={node.color}>{` ${node.char} `}</Text>
        <Text color={nameColor} bold={active}>
          {phase.name.padEnd(16)}
        </Text>
        {phase.detail !== undefined ? <Text color={colors.muted}>{phase.detail}</Text> : null}
      </Box>

      {active && phase.events !== undefined
        ? phase.events.map((event, index) => (
            <Box key={index}>
              <Text color={railColor}>{` ${glyph.railV}   `}</Text>
              <Text color={toneColor(event.tone, colors)}>
                {`${event.kind !== undefined ? eventGlyph[event.kind] : glyph.branch} `}
              </Text>
              <Text color={colors.text}>{event.text}</Text>
              {event.note !== undefined ? (
                <Text color={toneColor(event.tone, colors)}>{`  ${event.note}`}</Text>
              ) : null}
            </Box>
          ))
        : null}

      {!isLast ? <Text color={railColor}>{` ${glyph.railV}`}</Text> : null}
    </Box>
  );
}

function CostBar({ costCents, colors }: { costCents: number; colors: Palette }): ReactElement {
  const filled = Math.min(8, Math.max(1, Math.round(costCents / 6)));
  const bar = glyph.bar.repeat(filled) + glyph.barEmpty.repeat(8 - filled);
  return <Text color={colors.accentDim}>{bar}</Text>;
}

export function PhaseTimeline(props: PhaseTimelineProps): ReactElement {
  const { runId, title, autonomyLabel, phases, status, spinnerFrame, approval, done } = props;
  const colors = useColors();

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {/* Header */}
      <Box>
        <Text color={colors.accent} bold>
          {`${glyph.logo} `}
        </Text>
        <Text color={colors.muted}>{`${runId}  `}</Text>
        <Text color={colors.text} bold>
          {title}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={colors.muted}>{`   ${autonomyLabel} · ${status.model}`}</Text>
      </Box>

      {/* Timeline */}
      {phases.map((phase, index) => (
        <PhaseRow
          key={phase.id}
          phase={phase}
          isLast={index === phases.length - 1}
          spinnerFrame={spinnerFrame}
          colors={colors}
        />
      ))}

      {/* Inline approval */}
      {approval !== undefined ? (
        <Box marginTop={1}>
          <Text color={colors.warn}>{` ${glyph.waiting} `}</Text>
          <Text color={colors.text}>{approval.question}</Text>
          <Text color={colors.warn} bold>
            {`   ${approval.options}`}
          </Text>
        </Box>
      ) : null}

      {/* Status line */}
      <Box marginTop={1}>
        <Text color={colors.rail}>{' ──────────────────────────────────────────────────────'}</Text>
      </Box>
      <Box>
        <Text color={colors.muted}>{' '}</Text>
        <CostBar costCents={status.costCents} colors={colors} />
        <Text color={colors.muted}>{`  ${formatElapsed(status.elapsedMs)}`}</Text>
        <Text color={colors.muted}>{`  ·  ${formatCents(status.costCents)}`}</Text>
        <Text color={colors.muted}>{'  ·  '}</Text>
        <Text color={colors.success}>{status.safety}</Text>
        <Text color={colors.muted}>{'  ·  '}</Text>
        <Text color={status.push ? colors.warn : colors.muted}>{status.push ? 'push: on' : 'no push'}</Text>
        {done === true ? (
          <Text color={colors.success} bold>
            {'   ✓ done'}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
