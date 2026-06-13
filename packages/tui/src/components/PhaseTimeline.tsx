import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { color, glyph, spinnerFrames, formatCents, formatElapsed } from '../theme.js';

/**
 * `<PhaseTimeline>` — the live run visualization (M-Shell seed).
 *
 * A vertical timeline whose rail fills as phases complete, with the active
 * phase expanded to show its event stream and an inline approval prompt when a
 * phase is gated. Driven entirely by props, so the same component renders a mock
 * demo or a real run streamed from `ExcaliburEvent`s.
 */

export type PhaseState = 'pending' | 'running' | 'completed' | 'waiting' | 'failed';

export interface PhaseEvent {
  text: string;
  /** A trailing annotation rendered dim/coloured, e.g. "+24 −6" or "12 passing". */
  note?: string;
  tone?: 'muted' | 'accent' | 'success' | 'warn';
}

export interface Phase {
  id: string;
  name: string;
  state: PhaseState;
  /** One-line summary shown next to the phase name once it is active/done. */
  detail?: string;
  /** Streamed events, shown only while the phase is the active one. */
  events?: PhaseEvent[];
}

export interface ApprovalPrompt {
  question: string;
  options: string; // e.g. "[y/N/always]"
}

export interface RunStatus {
  elapsedMs: number;
  costCents: number;
  safety: string;
  push: boolean;
  model: string;
}

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

function stateGlyph(state: PhaseState, spinnerFrame: number): { char: string; color: string } {
  switch (state) {
    case 'completed':
      return { char: glyph.done, color: color.success };
    case 'running':
      return { char: spinnerFrames[spinnerFrame % spinnerFrames.length] ?? glyph.running, color: color.accent };
    case 'waiting':
      return { char: glyph.waiting, color: color.warn };
    case 'failed':
      return { char: glyph.failed, color: color.danger };
    case 'pending':
    default:
      return { char: glyph.pending, color: color.muted };
  }
}

function toneColor(tone: PhaseEvent['tone']): string {
  switch (tone) {
    case 'accent':
      return color.accent;
    case 'success':
      return color.success;
    case 'warn':
      return color.warn;
    case 'muted':
    default:
      return color.muted;
  }
}

function PhaseRow({ phase, isLast, spinnerFrame }: { phase: Phase; isLast: boolean; spinnerFrame: number }): ReactElement {
  const node = stateGlyph(phase.state, spinnerFrame);
  const active = phase.state === 'running' || phase.state === 'waiting';
  const railColor = phase.state === 'completed' ? color.success : color.rail;
  const nameColor = phase.state === 'pending' ? color.muted : color.text;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={node.color}>{` ${node.char} `}</Text>
        <Text color={nameColor} bold={active}>
          {phase.name.padEnd(16)}
        </Text>
        {phase.detail !== undefined ? <Text color={color.muted}>{phase.detail}</Text> : null}
      </Box>

      {active && phase.events !== undefined
        ? phase.events.map((event, index) => (
            <Box key={index}>
              <Text color={railColor}>{` ${glyph.railV}   `}</Text>
              <Text color={color.muted}>{`${glyph.branch} `}</Text>
              <Text color={color.text}>{event.text}</Text>
              {event.note !== undefined ? <Text color={toneColor(event.tone)}>{`  ${event.note}`}</Text> : null}
            </Box>
          ))
        : null}

      {!isLast ? (
        <Text color={railColor}>{` ${glyph.railV}`}</Text>
      ) : null}
    </Box>
  );
}

function CostBar({ costCents }: { costCents: number }): ReactElement {
  const filled = Math.min(8, Math.max(1, Math.round(costCents / 6)));
  const bar = glyph.bar.repeat(filled) + glyph.barEmpty.repeat(8 - filled);
  return <Text color={color.accentDim}>{bar}</Text>;
}

export function PhaseTimeline(props: PhaseTimelineProps): ReactElement {
  const { runId, title, autonomyLabel, phases, status, spinnerFrame, approval, done } = props;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {/* Header */}
      <Box>
        <Text color={color.accent} bold>
          {`${glyph.logo} `}
        </Text>
        <Text color={color.muted}>{`${runId}  `}</Text>
        <Text color={color.text} bold>
          {title}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={color.muted}>{`   ${autonomyLabel} · ${status.model}`}</Text>
      </Box>

      {/* Timeline */}
      {phases.map((phase, index) => (
        <PhaseRow
          key={phase.id}
          phase={phase}
          isLast={index === phases.length - 1}
          spinnerFrame={spinnerFrame}
        />
      ))}

      {/* Inline approval */}
      {approval !== undefined ? (
        <Box marginTop={1}>
          <Text color={color.warn}>{` ${glyph.waiting} `}</Text>
          <Text color={color.text}>{approval.question}</Text>
          <Text color={color.warn} bold>
            {`   ${approval.options}`}
          </Text>
        </Box>
      ) : null}

      {/* Status line */}
      <Box marginTop={1}>
        <Text color={color.rail}>{' ──────────────────────────────────────────────────────'}</Text>
      </Box>
      <Box>
        <Text color={color.muted}>{' '}</Text>
        <CostBar costCents={status.costCents} />
        <Text color={color.muted}>{`  ${formatElapsed(status.elapsedMs)}`}</Text>
        <Text color={color.muted}>{`  ·  ${formatCents(status.costCents)}`}</Text>
        <Text color={color.muted}>{'  ·  '}</Text>
        <Text color={color.success}>{status.safety}</Text>
        <Text color={color.muted}>{'  ·  '}</Text>
        <Text color={status.push ? color.warn : color.muted}>{status.push ? 'push: on' : 'no push'}</Text>
        {done === true ? (
          <Text color={color.success} bold>
            {'   ✓ done'}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
