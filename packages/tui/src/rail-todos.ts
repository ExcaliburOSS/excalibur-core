import { paint, type ColorTier } from './color.js';
import { ascii, getColors, glyph, type Palette, type ThemeMode } from './theme.js';
import type { TodoItem } from './rail-types.js';

/**
 * The in-session checklist band (the `task_update` event), rendered as text.
 * One line per item with a state glyph — ✓ completed (dim) · ◐ in-progress
 * (accent) · ○ pending (muted) — under a header showing the done/total count.
 * Unlike Claude Code's ephemeral TodoWrite, this is folded from the event
 * stream, so it is replayable and renders identically live, in `logs` and in a
 * scrub. Pure + colour-opt-in (English-default label; the CLI passes a localized
 * one).
 */

const RAIL = ascii ? '|' : '│';

export interface RenderTodosOptions {
  tier?: ColorTier;
  mode?: ThemeMode;
  /** Localized "Tasks" header word (defaults to English). */
  label?: string;
}

/** Glyph + colour for a todo status. */
function todoGlyph(status: TodoItem['status'], palette: Palette): { ch: string; hex: string } {
  switch (status) {
    case 'completed':
      return { ch: glyph.done, hex: palette.success };
    case 'in_progress':
      return { ch: glyph.running, hex: palette.accent };
    default:
      return { ch: glyph.pending, hex: palette.muted };
  }
}

/** Renders the checklist band to text lines (empty array when there are no todos). */
export function renderTodos(
  todos: ReadonlyArray<TodoItem>,
  options: RenderTodosOptions = {},
): string[] {
  if (todos.length === 0) {
    return [];
  }
  const tier: ColorTier = options.tier ?? 'none';
  const palette = getColors(options.mode ?? 'dark');
  const c = (text: string, hex: string): string =>
    tier === 'none' ? text : paint(text, hex, tier);

  const done = todos.filter((todo) => todo.status === 'completed').length;
  const lines: string[] = [
    ` ${c(glyph.logo, palette.accent)} ${c(options.label ?? 'Tasks', palette.text)}  ${c(
      `${done}/${todos.length}`,
      palette.muted,
    )}`,
  ];
  for (const todo of todos) {
    const g = todoGlyph(todo.status, palette);
    const textHex = todo.status === 'in_progress' ? palette.text : palette.muted;
    lines.push(` ${c(RAIL, palette.rail)}   ${c(g.ch, g.hex)} ${c(todo.text, textHex)}`.trimEnd());
  }
  return lines;
}
