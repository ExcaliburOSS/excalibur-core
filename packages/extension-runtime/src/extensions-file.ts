import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigValidationError } from '@excalibur/shared';
import { formatValidationIssues } from '@excalibur/workflow-schema';

/**
 * `.excalibur/extensions.yaml` (extensions spec §2):
 *
 * - `enabled`: extension ids explicitly enabled (advisory in M1 — every
 *   discovered extension is enabled unless listed in `disabled`).
 * - `disabled`: extension ids that must not be loaded.
 * - `local`: local programmatic extension directories (relative to
 *   `.excalibur/`, e.g. `./extensions/internal-tool`).
 * - `declarative`: extra declarative files to load (relative to
 *   `.excalibur/`, e.g. `./methodologies/discovery.yaml`).
 */
export const extensionsFileSchema = z.object({
  enabled: z.array(z.string().min(1)).optional(),
  disabled: z.array(z.string().min(1)).optional(),
  local: z.array(z.string().min(1)).optional(),
  declarative: z.array(z.string().min(1)).optional(),
});
export type ExtensionsFileConfig = z.infer<typeof extensionsFileSchema>;

/** Relative location of the extensions file inside a repository. */
export const EXTENSIONS_FILE_RELATIVE_PATH = '.excalibur/extensions.yaml';

/**
 * Load `.excalibur/extensions.yaml` for a repository. A missing (or empty)
 * file is not an error — extensions are optional — and yields `{}`. Invalid
 * YAML or schema violations throw `ConfigValidationError`.
 */
export function loadExtensionsFile(repoRoot: string): ExtensionsFileConfig {
  const filePath = join(repoRoot, '.excalibur', 'extensions.yaml');
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isFileMissingError(error)) {
      return {};
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError(`Cannot read ${filePath}: ${reason}`, { filePath });
  }
  let value: unknown;
  try {
    value = parseYaml(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError(`${filePath} is not valid YAML: ${reason}`, { filePath });
  }
  if (value === null || value === undefined) {
    return {};
  }
  const result = extensionsFileSchema.safeParse(value);
  if (!result.success) {
    const errors = formatValidationIssues(result.error);
    throw new ConfigValidationError(
      `Invalid extensions file ${filePath}:\n- ${errors.join('\n- ')}`,
      { filePath, errors },
    );
  }
  return result.data;
}

function isFileMissingError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'ENOENT' ||
      (error as { code?: unknown }).code === 'ENOTDIR')
  );
}
