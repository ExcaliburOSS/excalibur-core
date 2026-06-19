import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { ColorTier } from '../color.js';
import { renderDiff } from '../diff-view.js';
import { glyph, type Palette, type ThemeMode } from '../theme.js';

/**
 * `<DiffView>` — an inline, collapsible unified diff in the live rail. Reuses
 * the pure `renderDiff` (gutter, word-level highlight, width-adaptive
 * unified/side-by-side) and passes its PRE-COLOURED lines straight through a
 * `<Text>` with NO style props (`wrap="truncate-end"`) — Ink measures width with
 * string-width and re-serializes the SGR verbatim, so the diff keeps its own
 * colours (a styled parent `<Text>` would let chalk re-open and clobber them).
 *
 * Collapsed by default (Space toggles via the store); height-capped so a large
 * diff never blows past the live region.
 */

export interface DiffViewProps {
  diff: string;
  expanded: boolean;
  colors: Palette;
  tier?: ColorTier;
  mode?: ThemeMode;
  /** Content width budget (terminal columns); the rail prefix is reserved. */
  width?: number;
  /** Max diff body lines shown when expanded (rest summarised). */
  maxLines?: number;
}

const RAIL_PREFIX = ` ${glyph.railV}   `;
const RAIL_RESERVED = 6;
const DEFAULT_WIDTH = 80;
const DEFAULT_MAX_LINES = 24;

/** One indented row: a rail connector + a passthrough (or muted) cell. */
function Row({
  children,
  colors,
  muted,
}: {
  children: string;
  colors: Palette;
  muted?: boolean;
}): ReactElement {
  return (
    <Box>
      <Text color={colors.rail}>{RAIL_PREFIX}</Text>
      {muted === true ? (
        <Text color={colors.muted}>{children}</Text>
      ) : (
        <Text wrap="truncate-end">{children}</Text>
      )}
    </Box>
  );
}

export function DiffView(props: DiffViewProps): ReactElement | null {
  const { diff, expanded, colors, tier, mode, width, maxLines } = props;
  if (diff.trim().length === 0) {
    return null;
  }
  if (!expanded) {
    return <Row colors={colors} muted>{`${glyph.diffExpand} space to expand diff`}</Row>;
  }

  const cols = width ?? DEFAULT_WIDTH;
  const lines = renderDiff(diff, {
    tier: tier ?? 'none',
    palette: colors,
    width: Math.max(20, cols - RAIL_RESERVED),
    layout: 'auto',
    ...(mode !== undefined ? { mode } : {}),
  });
  const cap = maxLines ?? DEFAULT_MAX_LINES;
  const shown = lines.slice(0, cap);
  const hidden = lines.length - shown.length;

  return (
    <Box flexDirection="column">
      {shown.map((line, index) => (
        <Row key={index} colors={colors}>
          {line}
        </Row>
      ))}
      <Row colors={colors} muted>
        {hidden > 0
          ? `… +${hidden} more lines (space to collapse)`
          : `${glyph.diffCollapse} space to collapse`}
      </Row>
    </Box>
  );
}
