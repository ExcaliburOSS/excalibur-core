import { Command } from 'commander';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { defaultDeps, type CliDeps } from '../deps';
import { Ui } from '../ui';
import { CLI_VERSION } from '../program';
import {
  compareVersions,
  parseVersion,
  registerUpdateCommand,
  type LatestVersionLookup,
  type LatestVersionResult,
} from './update';

/** A memory sink that strips ANSI so assertions are color-independent. */
class MemoryStream extends Writable {
  chunks: string[] = [];

  override _write(chunk: unknown, _encoding: string, callback: () => void): void {
    this.chunks.push(String(chunk));
    callback();
  }

  text(): string {
    // eslint-disable-next-line no-control-regex
    return this.chunks.join('').replace(/\[[0-9;]*m/g, '');
  }
}

interface Harness {
  run(...argv: string[]): Promise<void>;
  stdout(): string;
  stderr(): string;
  /** Feeds a line to the prompt (interactive harness only). */
  send(line: string): void;
}

/**
 * Builds a standalone `update` command bound to memory streams and an injected
 * version lookup, so every run is deterministic and offline. `interactive`
 * drives `confirm` against a scripted stdin.
 */
function harness(lookup: LatestVersionLookup, options: { interactive?: boolean } = {}): Harness {
  const out = new MemoryStream();
  const err = new MemoryStream();
  const stdin = new PassThrough();
  const ui = new Ui({
    stdout: out,
    stderr: err,
    stdin,
    interactive: options.interactive ?? false,
  });
  const deps: CliDeps = defaultDeps({
    ui,
    cwd: () => process.cwd(),
    homeDir: () => process.cwd(),
    env: { PATH: process.env.PATH },
    includeUserGlobal: false,
  });
  const program = new Command();
  program.exitOverride();
  registerUpdateCommand(program, deps, lookup);
  return {
    run: (...argv: string[]): Promise<void> =>
      program.parseAsync(['node', 'excalibur', ...argv]).then(() => undefined),
    stdout: () => out.text(),
    stderr: () => err.text(),
    send: (line: string): void => {
      stdin.write(`${line}\n`);
    },
  };
}

/** A lookup that always resolves to a fixed result, never touching the network. */
function fixedLookup(result: LatestVersionResult): LatestVersionLookup {
  return () => Promise.resolve(result);
}

/** Bumps the patch of a dot-triple so a test can synthesize a "newer" version. */
function bumpPatch(version: string): string {
  const parts = version.split('-')[0]?.split('.') ?? [];
  const patch = Number.parseInt(parts[2] ?? '0', 10) + 1;
  return `${parts[0]}.${parts[1]}.${patch}`;
}

describe('parseVersion / compareVersions', () => {
  it('parses a numeric triple and rejects junk', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion('v0.1.0')).toEqual({ major: 0, minor: 1, patch: 0, prerelease: [] });
    expect(parseVersion('1.2.3-beta.1')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ['beta', '1'],
    });
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('1.x.0')).toBeNull();
  });

  it('orders releases and treats prereleases as older than the release', () => {
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.1')).toBeGreaterThan(0);
    // Unparseable inputs compare equal so junk is never read as an upgrade.
    expect(compareVersions('1.0.0', 'garbage')).toBe(0);
  });
});

describe('excalibur update', () => {
  it('reports up to date when installed === latest', async () => {
    const cli = harness(fixedLookup({ version: CLI_VERSION }));
    await cli.run('update');
    expect(cli.stdout()).toContain('up to date');
    expect(cli.stdout()).toContain(CLI_VERSION);
  });

  it('reports an available update and the upgrade command when newer is published', async () => {
    const newer = bumpPatch(CLI_VERSION);
    const cli = harness(fixedLookup({ version: newer }));
    await cli.run('update');
    const stdout = cli.stdout();
    expect(stdout).toContain(`Update available: ${CLI_VERSION} → ${newer}`);
    expect(stdout).toContain('npm i -g @excalibur/cli@latest');
  });

  it('does not prompt to upgrade when non-interactive (just surfaces the hint)', async () => {
    const newer = bumpPatch(CLI_VERSION);
    const cli = harness(fixedLookup({ version: newer }), { interactive: false });
    await cli.run('update');
    // Non-interactive: never offers to run it now.
    expect(cli.stdout()).not.toContain('now?');
  });

  it('treats a newer installed build as "nothing to update"', async () => {
    // Registry behind the installed build (dev/canary): report, do not downgrade.
    const cli = harness(fixedLookup({ version: '0.0.1' }));
    await cli.run('update');
    expect(cli.stdout()).toContain('Nothing to update');
  });

  it('never throws on a lookup failure — surfaces a friendly note', async () => {
    const cli = harness(
      fixedLookup({ version: null, error: 'getaddrinfo ENOTFOUND registry.npmjs.org' }),
    );
    await expect(cli.run('update')).resolves.toBeUndefined();
    // `warn` writes to stdout in this Ui (only `error` goes to stderr).
    const out = cli.stdout();
    expect(out).toContain('Could not check for updates');
    expect(out).toContain('ENOTFOUND');
    expect(out).toContain('npm i -g @excalibur/cli@latest');
  });

  it('emits machine-readable JSON for each status', async () => {
    const newer = bumpPatch(CLI_VERSION);

    const outdated = harness(fixedLookup({ version: newer }));
    await outdated.run('update', '--json');
    expect(JSON.parse(outdated.stdout())).toEqual({
      current: CLI_VERSION,
      latest: newer,
      status: 'outdated',
    });

    const current = harness(fixedLookup({ version: CLI_VERSION }));
    await current.run('update', '--json');
    expect(JSON.parse(current.stdout())).toEqual({
      current: CLI_VERSION,
      latest: CLI_VERSION,
      status: 'current',
    });

    const unknown = harness(fixedLookup({ version: null, error: 'offline' }));
    await unknown.run('update', '--json');
    expect(JSON.parse(unknown.stdout())).toEqual({
      current: CLI_VERSION,
      latest: null,
      status: 'unknown',
      error: 'offline',
    });
  });

  it('offers to run the upgrade interactively and declines on "n"', async () => {
    const newer = bumpPatch(CLI_VERSION);
    const cli = harness(fixedLookup({ version: newer }), { interactive: true });
    cli.send('n'); // decline the "Run ... now?" prompt
    await cli.run('update');
    const stdout = cli.stdout();
    expect(stdout).toContain(`Run "npm i -g @excalibur/cli@latest" now?`);
    // Declined → it never claims to have run/upgraded.
    expect(stdout).not.toContain('Running:');
  });
});
