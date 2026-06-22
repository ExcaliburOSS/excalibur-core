import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  ConfigValidationError,
  DEFAULT_CONFIG,
  excaliburConfigSchema,
  type ExcaliburConfig,
} from '@excalibur/shared';
import { isPlainObject } from '../internal/fs-utils';

/** Project configuration directory name (Build Contract §4.6). */
export const EXCALIBUR_DIR = '.excalibur';

export interface LoadedExcaliburConfig {
  config: ExcaliburConfig;
  source: 'file' | 'defaults';
  /** Path of the project `.excalibur/config.yaml` when present. */
  path?: string;
  /** Path of the user-global config when present + merged (P1.11b). */
  globalPath?: string;
}

/** Options for {@link loadExcaliburConfig}. */
export interface LoadExcaliburConfigOptions {
  /**
   * Home dir for the user-global config (`$XDG_CONFIG_HOME/excalibur/config.yaml`
   * or `<homeDir>/.config/excalibur/config.yaml`). Defaults to `os.homedir()`.
   */
  homeDir?: string;
  /**
   * Merge the user-global layer UNDER the project config (P1.11b). Default true.
   * Set false for a hermetic, project-only load (tests).
   */
  includeGlobal?: boolean;
}

/** Resolves the user-global config path (XDG-aware). */
function globalConfigPath(homeDir: string): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homeDir, '.config');
  return join(base, 'excalibur', 'config.yaml');
}

/**
 * Deep merge: plain objects merge recursively, everything else (scalars,
 * arrays) is replaced by the override. Explicit lists in the file (e.g.
 * `permissions.blockedPaths`) therefore replace the defaults entirely,
 * matching the shared `DEFAULT_CONFIG` merge semantics.
 */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    const existing = result[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = deepMerge(existing, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function validateConfig(value: unknown, filePath: string): ExcaliburConfig {
  const result = excaliburConfigSchema.safeParse(value);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new ConfigValidationError(
      `Invalid Excalibur config at ${filePath}: ${problems.join('; ')}`,
      { filePath, problems },
    );
  }
  return result.data;
}

/** Reads + parses + validates ONE config file (empty file → `{}`). Throws on error. */
function readConfigFile(filePath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError(`Cannot read Excalibur config at ${filePath}: ${reason}`, {
      filePath,
    });
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError(`Excalibur config ${filePath} is not valid YAML: ${reason}`, {
      filePath,
    });
  }
  // An empty config file is valid: it simply selects all defaults.
  return parsed === null || parsed === undefined
    ? {}
    : (validateConfig(parsed, filePath) as Record<string, unknown>);
}

/**
 * Loads Excalibur config for a repository (Build Contract §4.6), layering the
 * user-global config UNDER the project config (P1.11b):
 *
 *   `DEFAULT_CONFIG` < `~/.config/excalibur/config.yaml` < `.excalibur/config.yaml`
 *
 * (project values win over global, global over defaults). The global layer is
 * `$XDG_CONFIG_HOME/excalibur/config.yaml` when `XDG_CONFIG_HOME` is set, else
 * `<homeDir>/.config/excalibur/config.yaml`. Both layers are parsed, validated
 * against `excaliburConfigSchema`, and deep-merged. Neither present → defaults.
 *
 * @throws ConfigValidationError when a file is unreadable, not valid YAML or
 *   fails schema validation (message includes path + problem).
 */
export function loadExcaliburConfig(
  repoRoot: string,
  options: LoadExcaliburConfigOptions = {},
): LoadedExcaliburConfig {
  const projectPath = join(repoRoot, EXCALIBUR_DIR, 'config.yaml');
  const projectPresent = existsSync(projectPath);

  // User-global layer (default on). Resolved from XDG/home; merged UNDER project.
  let globalConfig: Record<string, unknown> = {};
  let globalPath: string | undefined;
  if (options.includeGlobal !== false) {
    const candidate = globalConfigPath(options.homeDir ?? homedir());
    if (existsSync(candidate)) {
      globalConfig = readConfigFile(candidate);
      globalPath = candidate;
    }
  }

  // Nothing configured anywhere → pure defaults.
  if (!projectPresent && globalPath === undefined) {
    return { config: DEFAULT_CONFIG, source: 'defaults' };
  }

  const projectConfig = projectPresent ? readConfigFile(projectPath) : {};
  // defaults < global < project.
  const merged = deepMerge(
    deepMerge(DEFAULT_CONFIG as Record<string, unknown>, globalConfig),
    projectConfig,
  );
  // Validate the merged result against the project path when present, else global.
  const validated = validateConfig(merged, projectPresent ? projectPath : (globalPath as string));
  return {
    config: validated,
    source: 'file',
    ...(projectPresent ? { path: projectPath } : {}),
    ...(globalPath !== undefined ? { globalPath } : {}),
  };
}
