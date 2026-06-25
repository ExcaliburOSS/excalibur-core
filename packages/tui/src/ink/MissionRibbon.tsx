import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { formatCents, formatElapsed, glyph } from '../theme.js';
import {
  missionStatusChar,
  missionStatusHex,
  type MissionRibbonModel,
  type MissionStepView,
} from '../mission-ribbon.js';
import { useColors } from './ThemeContext.js';

/**
 * `<MissionRibbon>` — the live Ink presenter of the meta-orchestrator's plan
 * ribbon (M7). It renders the capability DAG ABOVE the run rail so the user sees
 * where in the strategy the mission is, with the active capability's own rail
 * nested under its node (the CLI places `<RunView>` after this). Shares the status
 * glyph/colour logic with the pure `renderRibbon` string twin → live == replay.
 */

const ASCII_SKIP = '⊘';
const ASCII_RETRY = '↻';

export interface MissionRibbonProps {
  model: MissionRibbonModel;
  spinnerFrame: number;
}

function headerSuffix(model: MissionRibbonModel): string {
  const parts: string[] = [];
  if (model.spentCents !== undefined && model.spentCents > 0) {
    parts.push(
      model.budgetCents !== undefined && model.budgetCents > 0
        ? `${formatCents(model.spentCents)}/${formatCents(model.budgetCents)}`
        : formatCents(model.spentCents),
    );
  }
  if (model.criteriaTotal !== undefined && model.criteriaTotal > 0) {
    parts.push(`${model.criteriaMet ?? 0}/${model.criteriaTotal}`);
  }
  if (model.elapsedMs !== undefined && model.elapsedMs > 0)
    parts.push(formatElapsed(model.elapsedMs));
  return parts.length > 0 ? `  ${parts.join(' · ')}` : '';
}

function StepRow({
  step,
  last,
  spinnerFrame,
}: {
  step: MissionStepView;
  last: boolean;
  spinnerFrame: number;
}): ReactElement {
  const colors = useColors();
  const hex = missionStatusHex(step.status, colors);
  const ch = step.status === 'skipped' ? ASCII_SKIP : missionStatusChar(step.status, spinnerFrame);
  const connector = last ? glyph.branch : glyph.branchMid;
  const retry = (step.attempts ?? 1) > 1;
  return (
    <Box>
      <Text color={colors.rail}>{` ${connector} `}</Text>
      <Text color={hex}>{`${ch} `}</Text>
      <Text color={hex} bold={step.status === 'running'}>
        {step.capability.padEnd(12)}
      </Text>
      {step.gate ? <Text color={colors.warn}>{' (gate)'}</Text> : null}
      {retry ? <Text color={colors.warn}>{` ${ASCII_RETRY}`}</Text> : null}
      {step.objective.length > 0 ? (
        <Text color={colors.muted} wrap="truncate-end">{`  ${step.objective}`}</Text>
      ) : null}
    </Box>
  );
}

export function MissionRibbon({ model, spinnerFrame }: MissionRibbonProps): ReactElement {
  const colors = useColors();
  const outcomeColor =
    model.outcome === 'completed'
      ? colors.success
      : model.outcome === 'failed' || model.outcome === 'aborted'
        ? colors.danger
        : model.outcome === 'paused'
          ? colors.warn
          : colors.accent;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={outcomeColor}>{`◆ `}</Text>
        <Text color={colors.text} bold>
          {'Mission: '}
        </Text>
        <Text color={colors.text} wrap="truncate-end">
          {model.goal}
        </Text>
        <Text color={colors.muted}>{headerSuffix(model)}</Text>
      </Box>
      {model.steps.map((step, index) => (
        <StepRow
          key={step.id}
          step={step}
          last={index === model.steps.length - 1}
          spinnerFrame={spinnerFrame}
        />
      ))}
    </Box>
  );
}
