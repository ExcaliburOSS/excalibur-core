import { readPackageJson } from './internal/package-json';
import { detectStack } from './stack';
import type { DetectedCommands, PackageManager } from './types';

/** Accepted package.json script names per canonical command, in priority order. */
const SCRIPT_ALIASES: ReadonlyArray<readonly [keyof DetectedCommands, string[]]> = [
  ['test', ['test']],
  ['lint', ['lint']],
  ['typecheck', ['typecheck', 'type-check', 'check-types']],
  ['build', ['build']],
  // The local dev/preview server a developer runs to view the app (RUN-FIX-21).
  ['dev', ['dev', 'start', 'serve', 'preview']],
];

/**
 * Maps a package.json script to the command a developer would actually run,
 * through the detected package manager (onboarding-core.md §1:
 * `"test": "vitest"` + pnpm → `pnpm test`).
 */
function scriptCommand(
  manager: PackageManager,
  canonical: keyof DetectedCommands,
  scriptName: string,
): string {
  if (manager === 'bun') {
    // `bun test` invokes bun's own test runner, not the package script.
    return `bun run ${scriptName}`;
  }
  if (canonical === 'test' && scriptName === 'test') {
    return `${manager} test`;
  }
  return `${manager} run ${scriptName}`;
}

/**
 * Detects test/lint/typecheck/build commands from package.json scripts.
 * Undetectable commands are omitted — never invented (onboarding-core.md §1).
 */
export async function detectCommands(dir: string): Promise<DetectedCommands> {
  const pkg = await readPackageJson(dir);
  if (!pkg) {
    return {};
  }
  const { packageManager } = await detectStack(dir);
  const manager: PackageManager = packageManager ?? 'npm';

  const commands: DetectedCommands = {};
  for (const [canonical, aliases] of SCRIPT_ALIASES) {
    const scriptName = aliases.find((alias) => pkg.scripts[alias] !== undefined);
    if (scriptName !== undefined) {
      commands[canonical] = scriptCommand(manager, canonical, scriptName);
    }
  }
  return commands;
}
