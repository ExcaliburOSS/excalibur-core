import { existsSync, readFileSync } from 'node:fs';
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
  path?: string;
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

/**
 * Loads `.excalibur/config.yaml` for a repository (Build Contract §4.6).
 *
 * - Missing file → `{ config: DEFAULT_CONFIG, source: 'defaults' }`.
 * - Present file → parsed, validated against `excaliburConfigSchema` and deep
 *   merged over `DEFAULT_CONFIG` (file values win; `project.commands` is
 *   normalized into the top-level `commands` section by the schema).
 *
 * @throws ConfigValidationError when the file is unreadable, not valid YAML
 *   or fails schema validation (message includes path + problem).
 */
export function loadExcaliburConfig(repoRoot: string): LoadedExcaliburConfig {
  const filePath = join(repoRoot, EXCALIBUR_DIR, 'config.yaml');
  if (!existsSync(filePath)) {
    return { config: DEFAULT_CONFIG, source: 'defaults' };
  }

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
  const fileConfig =
    parsed === null || parsed === undefined ? {} : validateConfig(parsed, filePath);

  const merged = deepMerge(
    DEFAULT_CONFIG as Record<string, unknown>,
    fileConfig as Record<string, unknown>,
  );
  return { config: validateConfig(merged, filePath), source: 'file', path: filePath };
}
