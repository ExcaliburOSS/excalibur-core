import * as path from 'node:path';
import { isRecord, readJsonFile } from './fs-utils';

export interface PackageJsonInfo {
  name: string | null;
  packageManagerField: string | null;
  scripts: Record<string, string>;
  /** dependencies + devDependencies merged (names → ranges). */
  dependencies: Record<string, string>;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      out[key] = entry;
    }
  }
  return out;
}

/**
 * Reads `<dir>/package.json` leniently: missing or malformed files yield
 * `null` so repository analysis stays best-effort.
 */
export async function readPackageJson(dir: string): Promise<PackageJsonInfo | null> {
  const raw = await readJsonFile(path.join(dir, 'package.json'));
  if (!isRecord(raw)) {
    return null;
  }
  return {
    name: typeof raw['name'] === 'string' ? raw['name'] : null,
    packageManagerField: typeof raw['packageManager'] === 'string' ? raw['packageManager'] : null,
    scripts: stringRecord(raw['scripts']),
    dependencies: {
      ...stringRecord(raw['dependencies']),
      ...stringRecord(raw['devDependencies']),
    },
  };
}
