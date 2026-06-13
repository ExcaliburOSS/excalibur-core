import { CommandParseError, type ExecutionStyle } from '@excalibur/shared';

/**
 * Common `@excalibur` command parser for ticket/issue/Slack-thread comments
 * (docs/spec/work-items-core.md §4, docs/spec/discovery-core.md §7,
 * docs/spec/agentic-agile-core.md).
 */

export const EXCALIBUR_COMMANDS = [
  'refine',
  'plan',
  'review',
  'suggest-patch',
  'generate-tests',
  'implement',
  'careful',
  'explore',
  'status',
  'cancel',
  'daily',
  'planning',
  'discovery',
  'readiness',
  'acceptance-criteria',
  'split-scope',
] as const;
export type ExcaliburCommand = (typeof EXCALIBUR_COMMANDS)[number];

export const PLANNING_SUBCOMMANDS = [
  'start',
  'propose',
  'approve',
  'revise',
  'add',
  'remove',
  'owner',
  'careful',
  'run',
] as const;
export type PlanningSubcommand = (typeof PLANNING_SUBCOMMANDS)[number];

export const DISCOVERY_SUBCOMMANDS = [
  'complete',
  'create-linear',
  'update-ticket',
  'create-run',
  'save-decision',
] as const;
export type DiscoverySubcommand = (typeof DISCOVERY_SUBCOMMANDS)[number];

export interface ParsedExcaliburCommand {
  command: string;
  subcommand?: string;
  args: string[];
  flags: Record<string, string | boolean>;
  raw: string;
}

/** Command → action mapping result, consumed by Enterprise and the CLI. */
export type WorkItemCommandAction =
  | {
      kind: 'interaction';
      interactionType: 'work_item_refinement' | 'work_item_plan' | 'work_item_review';
      autonomyLevel: 0;
    }
  | { kind: 'patch'; autonomyLevel: 2; variant: 'suggest_patch' | 'generate_tests' }
  | { kind: 'run'; autonomyLevel: 3 | 4; executionStyle: ExecutionStyle }
  | { kind: 'status' }
  | { kind: 'cancel' }
  | { kind: 'daily' }
  | { kind: 'planning'; action: string; args: string[] }
  | { kind: 'discovery'; action?: string; args: string[] };

const COMMAND_SET: ReadonlySet<string> = new Set(EXCALIBUR_COMMANDS);
const PLANNING_SET: ReadonlySet<string> = new Set(PLANNING_SUBCOMMANDS);
const DISCOVERY_SET: ReadonlySet<string> = new Set(DISCOVERY_SUBCOMMANDS);

/**
 * Finds the first `@excalibur` mention. The mention is case-insensitive, must
 * not be preceded by a word character (so `support@excalibur.dev` is not a
 * mention) and must be followed by whitespace, `:`/`,` or the end of the text
 * (so `@excalibur-bot` and `@excalibur.dev` are skipped).
 */
function findFirstMention(text: string): { start: number; end: number } | null {
  const pattern = /(?<=^|[^\w])@excalibur\b/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const next = text[end];
    if (next === undefined || /\s/.test(next) || next === ':' || next === ',') {
      return { start, end };
    }
  }
  return null;
}

/** Lowercases a command/subcommand token and strips trailing prose punctuation. */
function normalizeWordToken(token: string): string {
  return token.toLowerCase().replace(/[)\].,!?:;'"]+$/, '');
}

function isFlagToken(token: string): boolean {
  return token.startsWith('--') && token.length > 2;
}

/**
 * Parses the first `@excalibur <command>` mention found anywhere in a comment.
 *
 * - Returns `null` when the text contains no `@excalibur` mention.
 * - Throws `CommandParseError` for unknown commands, missing commands after a
 *   mention, and unknown/missing `planning` subcommands.
 * - Parsing is scoped to the mention's line: `--flag value`, `--flag=value`
 *   and bare `--flag` forms are supported; remaining tokens become positional
 *   args (verbatim, e.g. `ENG-123`, `@rafael`).
 * - `planning` requires one of `PLANNING_SUBCOMMANDS`; `discovery` accepts an
 *   optional subcommand from `DISCOVERY_SUBCOMMANDS`.
 */
export function parseExcaliburCommand(text: string): ParsedExcaliburCommand | null {
  const mention = findFirstMention(text);
  if (mention === null) {
    return null;
  }

  const newlineIndex = text.indexOf('\n', mention.end);
  const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
  const raw = text.slice(mention.start, lineEnd).trim();
  // Allow a single `:` or `,` right after the mention ("@excalibur: status").
  const segment = text.slice(mention.end, lineEnd).replace(/^[ \t]*[:,]/, '');
  const tokens = segment.split(/\s+/).filter((token) => token.length > 0);

  const commandToken = tokens.shift();
  if (commandToken === undefined) {
    throw new CommandParseError('Found an @excalibur mention without a command.', { raw });
  }
  const command = normalizeWordToken(commandToken);
  if (!COMMAND_SET.has(command)) {
    throw new CommandParseError(`Unknown @excalibur command: "${commandToken}".`, {
      command: commandToken,
      raw,
      knownCommands: [...EXCALIBUR_COMMANDS],
    });
  }

  let subcommand: string | undefined;
  if (command === 'planning') {
    const subToken = tokens[0];
    const normalized = subToken !== undefined ? normalizeWordToken(subToken) : undefined;
    if (subToken === undefined || isFlagToken(subToken) || normalized === undefined) {
      throw new CommandParseError(
        '"@excalibur planning" requires a subcommand (start|propose|approve|revise|add|remove|owner|careful|run).',
        { command, raw },
      );
    }
    if (!PLANNING_SET.has(normalized)) {
      throw new CommandParseError(`Unknown planning subcommand: "${subToken}".`, {
        command,
        subcommand: subToken,
        raw,
        knownSubcommands: [...PLANNING_SUBCOMMANDS],
      });
    }
    subcommand = normalized;
    tokens.shift();
  } else if (command === 'discovery') {
    const subToken = tokens[0];
    if (subToken !== undefined && !isFlagToken(subToken)) {
      const normalized = normalizeWordToken(subToken);
      if (DISCOVERY_SET.has(normalized)) {
        subcommand = normalized;
        tokens.shift();
      }
    }
  }

  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    index += 1;
    if (token === undefined) {
      break;
    }
    if (!isFlagToken(token)) {
      args.push(token);
      continue;
    }
    const equalsIndex = token.indexOf('=');
    if (equalsIndex > 2) {
      flags[token.slice(2, equalsIndex)] = token.slice(equalsIndex + 1);
      continue;
    }
    const name = token.slice(2);
    const next = tokens[index];
    if (next !== undefined && !isFlagToken(next)) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }

  const parsed: ParsedExcaliburCommand = { command, args, flags, raw };
  if (subcommand !== undefined) {
    parsed.subcommand = subcommand;
  }
  return parsed;
}

/**
 * Maps a parsed command to the action it creates (the mapping table in
 * docs/spec/work-items-core.md §4 plus the Discovery additions of
 * docs/spec/discovery-core.md §7).
 */
export function commandToAction(parsed: ParsedExcaliburCommand): WorkItemCommandAction {
  switch (parsed.command) {
    case 'refine':
      return { kind: 'interaction', interactionType: 'work_item_refinement', autonomyLevel: 0 };
    case 'plan':
      return { kind: 'interaction', interactionType: 'work_item_plan', autonomyLevel: 0 };
    case 'review':
      return { kind: 'interaction', interactionType: 'work_item_review', autonomyLevel: 0 };
    case 'suggest-patch':
      return { kind: 'patch', autonomyLevel: 2, variant: 'suggest_patch' };
    case 'generate-tests':
      // PatchRequest by default; Enterprise may upgrade to an AgentRun per config.
      return { kind: 'patch', autonomyLevel: 2, variant: 'generate_tests' };
    case 'implement':
      return { kind: 'run', autonomyLevel: 3, executionStyle: 'team_default' };
    case 'careful':
      return { kind: 'run', autonomyLevel: 4, executionStyle: 'careful' };
    case 'explore':
      return { kind: 'run', autonomyLevel: 3, executionStyle: 'explore' };
    case 'status':
      return { kind: 'status' };
    case 'cancel':
      return { kind: 'cancel' };
    case 'daily':
      return { kind: 'daily' };
    case 'planning': {
      if (parsed.subcommand === undefined) {
        throw new CommandParseError('"planning" actions require a subcommand.', {
          command: parsed.command,
          raw: parsed.raw,
        });
      }
      return { kind: 'planning', action: parsed.subcommand, args: [...parsed.args] };
    }
    case 'discovery': {
      if (parsed.subcommand !== undefined) {
        return { kind: 'discovery', action: parsed.subcommand, args: [...parsed.args] };
      }
      return { kind: 'discovery', args: [...parsed.args] };
    }
    case 'readiness':
    case 'acceptance-criteria':
    case 'split-scope':
      return { kind: 'discovery', action: parsed.command, args: [...parsed.args] };
    default:
      throw new CommandParseError(`Unknown @excalibur command: "${parsed.command}".`, {
        command: parsed.command,
        raw: parsed.raw,
        knownCommands: [...EXCALIBUR_COMMANDS],
      });
  }
}
