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
 * Shows a PEEK by default — the first {@link DiffViewProps.peek} lines of the
 * change so its content is visible at a glance — and the full body (Space toggles
 * via the store). Height-capped so a large diff never blows past the live region.
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
  /**
   * When set (and not expanded), show the first `peek` lines of the diff instead
   * of a bare "space to expand" stub — so the change is visible by default. The
   * rail wires this onto the most-recent change only, to keep the live tail short.
   */
  peek?: number;
}

const RAIL_PREFIX = ` ${glyph.railV}   `;
const RAIL_RESERVED = 6;
const DEFAULT_WIDTH = 80;
const DEFAULT_MAX_LINES = 24;
/**
 * Lines of the most-recent diff shown by default (a generous peek, not the stub).
 * The rail caps this to the terminal height (RUN-FIX-7), so on a tall terminal you
 * get the whole ~25-line glance and on a short one it shrinks to fit.
 */
export const DEFAULT_PEEK_LINES = 25;

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
  const { diff, expanded, colors, tier, mode, width, maxLines, peek } = props;
  if (diff.trim().length === 0) {
    return null;
  }
  // Not expanded and no peek requested → the legacy one-line stub (used for older
  // changes in the tail, whose `+N −M` summary already rides on their event row).
  if (!expanded && peek === undefined) {
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
  const cap = expanded ? (maxLines ?? DEFAULT_MAX_LINES) : (peek ?? DEFAULT_PEEK_LINES);
  const shown = lines.slice(0, cap);
  const hidden = lines.length - shown.length;

  // The footer hint: when expanded, offer to collapse; when peeking, offer to
  // expand the rest (and nothing at all when the whole diff already fits the peek
  // — the change is fully visible, so no chrome is needed).
  const footer = expanded
    ? hidden > 0
      ? `… +${hidden} more lines (space to collapse)`
      : `${glyph.diffCollapse} space to collapse`
    : hidden > 0
      ? `… +${hidden} more lines (space to expand)`
      : null;

  return (
    <Box flexDirection="column">
      {shown.map((line, index) => (
        <Row key={index} colors={colors}>
          {line}
        </Row>
      ))}
      {footer !== null ? (
        <Row colors={colors} muted>
          {footer}
        </Row>
      ) : null}
    </Box>
  );
}
