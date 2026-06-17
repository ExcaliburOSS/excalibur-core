import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { CLI_VERSION } from '../program';

const execFileAsync = promisify(execFile);

/** The published package this CLI ships as (used by both the lookup and the upgrade hint). */
const PACKAGE_NAME = '@excalibur/cli';
/** Upgrade command surfaced to the user (and offered to run when interactive). */
const UPGRADE_COMMAND = `npm i -g ${PACKAGE_NAME}@latest`;
/** Hard ceiling on the `npm view` lookup so an offline/slow registry never hangs the CLI. */
const LOOKUP_TIMEOUT_MS = 5_000;

/**
 * The result of resolving the latest published version. `version` is the
 * dot-separated semver string on success; `error` carries a short, human-
 * readable reason on failure (offline, registry error, timeout, …). The lookup
 * NEVER throws — a failure is reported, never propagated.
 */
export interface LatestVersionResult {
  version: string | null;
  error?: string;
}

/**
 * Resolves the latest published version of a package, injectable so tests run
 * deterministically offline. The default implementation shells out to
 * `npm view <pkg> version` with a short timeout and maps any failure (no npm,
 * offline, registry error, non-semver output) onto a {@link LatestVersionResult}
 * with `version: null` rather than throwing.
 */
export type LatestVersionLookup = (deps: CliDeps) => Promise<LatestVersionResult>;

/** A semver triple plus an optional pre-release tag (e.g. `1.2.3-beta.1`). */
interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated pre-release identifiers, empty for a stable release. */
  prerelease: string[];
}

/**
 * Parses a `MAJOR.MINOR.PATCH[-prerelease]` string (build metadata after `+`
 * is ignored, per semver). Returns `null` for anything that is not a valid
 * numeric triple so callers can degrade gracefully instead of guessing.
 */
export function parseVersion(raw: string): ParsedVersion | null {
  const trimmed = raw.trim().replace(/^v/, '');
  const [core, prereleaseRaw] = trimmed.split('+')[0]?.split('-', 2) ?? [];
  const parts = (core ?? '').split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [major, minor, patch] = parts.map((part) => Number.parseInt(part, 10));
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    Number.isNaN(major) ||
    Number.isNaN(minor) ||
    Number.isNaN(patch)
  ) {
    return null;
  }
  return {
    major,
    minor,
    patch,
    prerelease:
      prereleaseRaw !== undefined && prereleaseRaw.length > 0 ? prereleaseRaw.split('.') : [],
  };
}

/**
 * Compares two semver strings: returns a negative number when `a` is older,
 * positive when `a` is newer, and `0` when equal or incomparable. A stable
 * release outranks a pre-release of the same triple (semver §11). Unparseable
 * inputs compare as equal (`0`) so a malformed registry value can never be
 * mistaken for an available upgrade.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) {
    return 0;
  }
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  if (left.patch !== right.patch) {
    return left.patch - right.patch;
  }
  // Same triple: a release (no prerelease) is newer than any prerelease.
  if (left.prerelease.length === 0 && right.prerelease.length > 0) {
    return 1;
  }
  if (left.prerelease.length > 0 && right.prerelease.length === 0) {
    return -1;
  }
  // Both pre-releases: compare identifiers left-to-right (numeric < non-numeric).
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const lid = left.prerelease[index];
    const rid = right.prerelease[index];
    if (lid === undefined) {
      return -1; // a has fewer identifiers ⇒ lower precedence
    }
    if (rid === undefined) {
      return 1;
    }
    const ln = Number.parseInt(lid, 10);
    const rn = Number.parseInt(rid, 10);
    const lIsNum = !Number.isNaN(ln) && /^\d+$/.test(lid);
    const rIsNum = !Number.isNaN(rn) && /^\d+$/.test(rid);
    if (lIsNum && rIsNum) {
      if (ln !== rn) {
        return ln - rn;
      }
    } else if (lIsNum !== rIsNum) {
      return lIsNum ? -1 : 1; // numeric identifiers have lower precedence
    } else if (lid !== rid) {
      return lid < rid ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Default {@link LatestVersionLookup}: `npm view @excalibur/cli version`. Runs
 * with the command's environment (so a proxy/registry config is honored), a
 * short timeout, and total failure isolation — any error (npm missing, offline,
 * timeout, junk output) becomes `{ version: null, error }`.
 */
export const npmViewLatestVersion: LatestVersionLookup = async (deps) => {
  try {
    const { stdout } = await execFileAsync('npm', ['view', PACKAGE_NAME, 'version'], {
      timeout: LOOKUP_TIMEOUT_MS,
      env: deps.env,
      // npm prints the bare version to stdout; cap the buffer defensively.
      maxBuffer: 1024 * 1024,
    });
    const version = stdout.trim().split(/\s+/).pop() ?? '';
    if (parseVersion(version) === null) {
      return { version: null, error: `unexpected npm output: "${stdout.trim().slice(0, 80)}"` };
    }
    return { version };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { version: null, error: message };
  }
};

/**
 * `excalibur update` — checks whether a newer `@excalibur/cli` is published and,
 * when interactive, offers to run the global upgrade. Never throws on a failed
 * lookup: an offline/registry error becomes a friendly note. The version lookup
 * is injectable (defaults to {@link npmViewLatestVersion}) so tests are
 * deterministic and offline.
 */
export function registerUpdateCommand(
  program: Command,
  deps: CliDeps,
  lookup: LatestVersionLookup = npmViewLatestVersion,
): void {
  program
    .command('update')
    .description('check for a newer @excalibur/cli and upgrade')
    .option('--json', 'machine-readable JSON output')
    .option('-y, --yes', 'run the upgrade without prompting (when an update is available)')
    .action(async (options: { json?: boolean; yes?: boolean }) => {
      const current = CLI_VERSION;
      // Skip the human "checking…" chatter in --json mode so stdout is a single
      // parseable JSON document (info/warn/json all write to stdout here).
      if (options.json !== true) {
        deps.ui.info(deps.t('update.checking', { current }));
      }
      const { version: latest, error } = await lookup(deps);

      if (latest === null) {
        if (options.json === true) {
          deps.ui.json({
            current,
            latest: null,
            status: 'unknown',
            ...(error !== undefined ? { error } : {}),
          });
          return;
        }
        deps.ui.warn(
          deps.t('update.check-failed', {
            errSuffix: error !== undefined ? ` (${error})` : '',
            cmd: UPGRADE_COMMAND,
          }),
        );
        return;
      }

      const comparison = compareVersions(current, latest);
      const status = comparison < 0 ? 'outdated' : comparison > 0 ? 'ahead' : 'current';

      if (options.json === true) {
        deps.ui.json({ current, latest, status });
        return;
      }

      if (status === 'current') {
        deps.ui.success(deps.t('update.up-to-date', { current }));
        return;
      }

      if (status === 'ahead') {
        // Installed is newer than the registry (local/dev/canary build): nothing to do.
        deps.ui.info(deps.t('update.ahead', { current, latest }));
        return;
      }

      // status === 'outdated' → a newer version is available.
      deps.ui.write();
      deps.ui.heading(deps.t('update.available', { current, latest }));
      deps.ui.info(deps.t('update.upgrade-with', { cmd: UPGRADE_COMMAND }));

      if (!deps.ui.isInteractive() && options.yes !== true) {
        return; // non-interactive without --yes: just surface the hint.
      }

      const shouldRun =
        options.yes === true ||
        (await deps.ui.confirm(deps.t('update.confirm-run', { cmd: UPGRADE_COMMAND }), {
          defaultYes: true,
        }));
      if (!shouldRun) {
        return;
      }

      deps.ui.info(deps.t('update.running', { cmd: UPGRADE_COMMAND }));
      try {
        const { stdout, stderr } = await execFileAsync(
          'npm',
          ['i', '-g', `${PACKAGE_NAME}@latest`],
          {
            env: deps.env,
            maxBuffer: 16 * 1024 * 1024,
          },
        );
        const tail = `${stdout}${stderr}`.trim();
        if (tail.length > 0) {
          deps.ui.write(tail);
        }
        deps.ui.success(deps.t('update.upgraded', { latest }));
      } catch (runError) {
        const message = runError instanceof Error ? runError.message : String(runError);
        // A failed upgrade is reported, never fatal — re-run the command manually.
        deps.ui.warn(deps.t('update.upgrade-failed', { message, cmd: UPGRADE_COMMAND }));
      }
    });
}
