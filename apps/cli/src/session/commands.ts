/**
 * The slash-command catalog for the in-line command menu: when the user types
 * `/`, the editor lists these (name + brief description) and filters them live
 * as more of the command is typed. Descriptions are localized via `t`.
 *
 * Order is the menu order. Kept in sync with the `/help` text and the dispatch
 * switch in `repl.ts`; aliases (e.g. `quit`) are omitted to keep the list tight.
 */
type Translate = (key: string, vars?: Record<string, string | number>) => string;

const COMMAND_KEYS: { name: string; key: string }[] = [
  { name: 'help', key: 'cmd.help' },
  { name: 'plan', key: 'cmd.plan' },
  { name: 'discovery', key: 'cmd.discovery' },
  { name: 'swarm', key: 'cmd.swarm' },
  { name: 'explore', key: 'cmd.explore' },
  { name: 'bg', key: 'cmd.bg' },
  { name: 'threads', key: 'cmd.threads' },
  { name: 'goal', key: 'cmd.goal' },
  { name: 'loop', key: 'cmd.loop' },
  { name: 'changes', key: 'cmd.changes' },
  { name: 'rewind', key: 'cmd.rewind' },
  { name: 'replay', key: 'cmd.replay' },
  { name: 'fork', key: 'cmd.fork' },
  { name: 'undo', key: 'cmd.undo' },
  { name: 'log', key: 'cmd.log' },
  { name: 'remember', key: 'cmd.remember' },
  { name: 'compact', key: 'cmd.compact' },
  { name: 'auto', key: 'cmd.auto' },
  { name: 'model', key: 'cmd.model' },
  { name: 'clear', key: 'cmd.clear' },
  { name: 'exit', key: 'cmd.exit' },
];

/** The localized command list for the editor's `/` menu. */
export function slashCommands(t: Translate): { name: string; description: string }[] {
  return COMMAND_KEYS.map(({ name, key }) => ({ name, description: t(key) }));
}
