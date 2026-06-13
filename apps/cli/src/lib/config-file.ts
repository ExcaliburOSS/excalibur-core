import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { EXCALIBUR_DIR } from '@excalibur/core';
import { ConfigValidationError } from '@excalibur/shared';

/**
 * Raw YAML editing helpers for `.excalibur/config.yaml` and
 * `.excalibur/extensions.yaml`. The CLI persists instruction/skill/extension
 * enablement here (ISD spec §7, extensions spec §9). Files are rewritten via
 * parse → modify → stringify; unknown keys are preserved.
 */

function readYamlObject(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(filePath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError(`${filePath} is not valid YAML: ${reason}`, { filePath });
  }
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigValidationError(`${filePath} must contain a YAML mapping at the root.`, {
      filePath,
    });
  }
  return parsed as Record<string, unknown>;
}

function writeYamlObject(filePath: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, stringifyYaml(value), 'utf8');
}

export function configFilePath(repoRoot: string): string {
  return join(repoRoot, EXCALIBUR_DIR, 'config.yaml');
}

export function extensionsFilePath(repoRoot: string): string {
  return join(repoRoot, EXCALIBUR_DIR, 'extensions.yaml');
}

export function readRawConfig(repoRoot: string): Record<string, unknown> {
  return readYamlObject(configFilePath(repoRoot));
}

export function writeRawConfig(repoRoot: string, config: Record<string, unknown>): void {
  writeYamlObject(configFilePath(repoRoot), config);
}

export interface SourceRef extends Record<string, unknown> {
  path: string;
}

function sectionSources(config: Record<string, unknown>, section: string): SourceRef[] {
  const block = config[section];
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    return [];
  }
  const sources = (block as Record<string, unknown>)['sources'];
  if (!Array.isArray(sources)) {
    return [];
  }
  return sources.filter(
    (entry): entry is SourceRef =>
      typeof entry === 'object' && entry !== null && typeof (entry as SourceRef).path === 'string',
  );
}

function normalizePath(path: string): string {
  let normalized = path.replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

/**
 * Upserts an instruction or skill source reference in config.yaml
 * (`instructions.sources` / `skills.sources`), matching entries by path.
 */
export function upsertSourceRef(
  repoRoot: string,
  section: 'instructions' | 'skills',
  ref: SourceRef,
): void {
  const config = readRawConfig(repoRoot);
  const sources = sectionSources(config, section);
  const index = sources.findIndex((entry) => samePath(entry.path, ref.path));
  if (index >= 0) {
    sources[index] = { ...sources[index], ...ref };
  } else {
    sources.push(ref);
  }
  config[section] = { ...(config[section] as Record<string, unknown> | undefined), sources };
  writeRawConfig(repoRoot, config);
}

/** Reads the configured enabled flag for a source path (`undefined` = not configured). */
export function configuredEnabled(
  repoRoot: string,
  section: 'instructions' | 'skills',
  path: string,
): boolean | undefined {
  const sources = sectionSources(readRawConfig(repoRoot), section);
  const entry = sources.find((candidate) => samePath(candidate.path, path));
  const enabled = entry?.['enabled'];
  return typeof enabled === 'boolean' ? enabled : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Enables or disables an extension id in `.excalibur/extensions.yaml`. */
export function setExtensionEnabled(repoRoot: string, id: string, enabled: boolean): void {
  const filePath = extensionsFilePath(repoRoot);
  const file = readYamlObject(filePath);
  const enabledList = stringArray(file['enabled']).filter((entry) => entry !== id);
  const disabledList = stringArray(file['disabled']).filter((entry) => entry !== id);
  if (enabled) {
    enabledList.push(id);
  } else {
    disabledList.push(id);
  }
  if (enabledList.length > 0) {
    file['enabled'] = enabledList;
  } else {
    delete file['enabled'];
  }
  if (disabledList.length > 0) {
    file['disabled'] = disabledList;
  } else {
    delete file['disabled'];
  }
  writeYamlObject(filePath, file);
}
