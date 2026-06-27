import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { glyph } from '../theme.js';
import {
  planStatusChar,
  planStatusHex,
  type PlanRibbonModel,
  type PlanRibbonStepView,
} from '../plan-ribbon.js';
import { useColors } from './ThemeContext.js';

/**
 * `<PlanRibbon>` — the live Ink presenter of the structured plan (PLAN4), pinned
 * ABOVE the run rail while the plan executes step by step (PLAN3): a phase→step
 * tree with each step's live status, so the user sees where in the plan the agent
 * is and what's left. Shares the status glyph/colour logic with the pure
 * `renderPlanRibbon` string twin → live == replay == non-TTY.
 */

export interface PlanRibbonProps {
  model: PlanRibbonModel;
  spinnerFrame: number;
}

function StepRow({
  step,
  last,
  spinnerFrame,
}: {
  step: PlanRibbonStepView;
  last: boolean;
  spinnerFrame: number;
}): ReactElement {
  const colors = useColors();
  const hex = planStatusHex(step.status, colors);
  const ch = planStatusChar(step.status, spinnerFrame);
  const connector = last ? glyph.branch : glyph.branchMid;
  return (
    <Box>
      <Text color={colors.rail}>{` ${connector} `}</Text>
      <Text color={hex}>{`${ch} `}</Text>
      <Text color={hex} bold={step.status === 'active'} wrap="truncate-end">
        {step.title}
      </Text>
    </Box>
  );
}

export function PlanRibbon({ model, spinnerFrame }: PlanRibbonProps): ReactElement {
  const colors = useColors();
  const outcomeColor =
    model.outcome === 'completed'
      ? colors.success
      : model.outcome === 'blocked'
        ? colors.danger
        : model.outcome === 'paused'
          ? colors.warn
          : colors.accent;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={outcomeColor}>{`◆ `}</Text>
        <Text color={colors.text} bold>
          {'Plan: '}
        </Text>
        <Text color={colors.text} wrap="truncate-end">
          {model.task}
        </Text>
        {model.total > 0 ? (
          <Text color={colors.muted}>{`  ${model.done}/${model.total}`}</Text>
        ) : null}
      </Box>
      {model.phases.map((phase) => (
        <Box flexDirection="column" key={phase.id}>
          {phase.title.length > 0 ? <Text color={colors.text}>{`  ${phase.title}`}</Text> : null}
          {phase.steps.map((step, index) => (
            <StepRow
              key={step.id}
              step={step}
              last={index === phase.steps.length - 1}
              spinnerFrame={spinnerFrame}
            />
          ))}
        </Box>
      ))}
    </Box>
  );
}
