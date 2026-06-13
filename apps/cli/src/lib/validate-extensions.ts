import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  parseDeclarativeMarkdown,
  parseDeclarativeYaml,
  type DeclarativeType,
} from '@excalibur/declarative-schemas';
import {
  loadExtensionsFile,
  loadManifest,
  validatePermissions,
  type ExtensionContributions,
  type ExtensionManifest,
} from '@excalibur/extension-runtime';
import { EXCALIBUR_DIR } from '@excalibur/core';

/**
 * `excalibur extensions validate` engine: validates every manifest and
 * declarative file reachable from the repository — `.excalibur/extensions.yaml`,
 * the 10 project declarative directories, the `declarative:` list and every
 * extension directory manifest plus its referenced files.
 */

export interface ValidationIssue {
  file: string;
  message: string;
}

export interface ValidationReport {
  /** Relative paths of every file that was checked. */
  checked: string[];
  errors: ValidationIssue[];
  warnings: string[];
}

const PROJECT_DECLARATIVE_DIRS: ReadonlyArray<{ dirName: string; type: DeclarativeType }> = [
  { dirName: 'methodologies', type: 'methodology' },
  { dirName: 'workflows', type: 'workflow' },
  { dirName: 'question-packs', type: 'question_pack' },
  { dirName: 'prompts', type: 'prompt_template' },
  { dirName: 'artifacts', type: 'artifact_template' },
  { dirName: 'policies', type: 'policy_preset' },
  { dirName: 'models', type: 'model_routing' },
  { dirName: 'reports', type: 'report_template' },
  { dirName: 'roles', type: 'role_definition' },
  { dirName: 'command-mappings', type: 'command_mapping' },
];

const MANIFEST_CONTRIBUTES: ReadonlyArray<{ key: keyof ExtensionContributions; type: DeclarativeType }> = [
  { key: 'methodologies', type: 'methodology' },
  { key: 'workflows', type: 'workflow' },
  { key: 'questionPacks', type: 'question_pack' },
  { key: 'promptTemplates', type: 'prompt_template' },
  { key: 'artifactTemplates', type: 'artifact_template' },
  { key: 'policyPresets', type: 'policy_preset' },
  { key: 'modelRouting', type: 'model_routing' },
  { key: 'reportTemplates', type: 'report_template' },
  { key: 'roleDefinitions', type: 'role_definition' },
  { key: 'commandMappings', type: 'command_mapping' },
];

const YAML_PATTERN = /\.ya?ml$/i;
const MARKDOWN_PATTERN = /\.(md|markdown)$/i;
const MANIFEST_FILE = 'excalibur.extension.yaml';

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return [];
  }
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile());
}

function listDirs(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return [];
  }
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isDirectory());
}

function validateDeclarativeFile(
  report: ValidationReport,
  repoRoot: string,
  absPath: string,
  expectedType: DeclarativeType | undefined,
): void {
  const rel = relative(repoRoot, absPath);
  report.checked.push(rel);
  let content: string;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch (error) {
    report.errors.push({ file: rel, message: `cannot read file: ${describe(error)}` });
    return;
  }
  try {
    if (MARKDOWN_PATTERN.test(absPath)) {
      parseDeclarativeMarkdown(absPath, content);
    } else if (expectedType !== undefined) {
      parseDeclarativeYaml(content, expectedType);
    } else {
      parseDeclarativeYaml(content);
    }
  } catch (error) {
    report.errors.push({ file: rel, message: describe(error) });
  }
}

function validateExtensionDir(report: ValidationReport, repoRoot: string, dir: string): void {
  const manifestPath = join(dir, MANIFEST_FILE);
  const rel = relative(repoRoot, manifestPath);
  if (!existsSync(manifestPath)) {
    report.errors.push({ file: relative(repoRoot, dir), message: `missing ${MANIFEST_FILE}` });
    return;
  }
  report.checked.push(rel);
  let manifest: ExtensionManifest;
  try {
    manifest = loadManifest(manifestPath);
  } catch (error) {
    report.errors.push({ file: rel, message: describe(error) });
    return;
  }
  report.warnings.push(...validatePermissions(manifest));

  if (manifest.kind !== 'declarative' && manifest.entrypoint === undefined) {
    report.errors.push({
      file: rel,
      message: `kind "${manifest.kind}" requires an entrypoint (e.g. dist/index.js)`,
    });
  }

  for (const { key, type } of MANIFEST_CONTRIBUTES) {
    const refs = manifest.contributes?.[key];
    if (!Array.isArray(refs)) {
      continue;
    }
    for (const ref of refs) {
      const refPath = resolve(dir, ref);
      if (!existsSync(refPath)) {
        report.errors.push({
          file: rel,
          message: `contributes.${key} references missing file ${ref}`,
        });
        continue;
      }
      validateDeclarativeFile(report, repoRoot, refPath, type);
    }
  }
}

export function validateRepoExtensions(repoRoot: string): ValidationReport {
  const report: ValidationReport = { checked: [], errors: [], warnings: [] };
  const excaliburDir = join(repoRoot, EXCALIBUR_DIR);

  // 1. extensions.yaml itself.
  const extensionsYaml = join(excaliburDir, 'extensions.yaml');
  let declarativeRefs: string[] = [];
  let localDirs: string[] = [];
  if (existsSync(extensionsYaml)) {
    report.checked.push(relative(repoRoot, extensionsYaml));
    try {
      const file = loadExtensionsFile(repoRoot);
      declarativeRefs = file.declarative ?? [];
      localDirs = file.local ?? [];
    } catch (error) {
      report.errors.push({ file: relative(repoRoot, extensionsYaml), message: describe(error) });
    }
  }

  // 2. The 10 project declarative directories.
  const seen = new Set<string>();
  for (const { dirName, type } of PROJECT_DECLARATIVE_DIRS) {
    for (const filePath of listFiles(join(excaliburDir, dirName))) {
      // providers.yaml is model provider config (OSS §14), not declarative.
      if (dirName === 'models' && /providers\.ya?ml$/i.test(filePath)) {
        continue;
      }
      if (!YAML_PATTERN.test(filePath) && !MARKDOWN_PATTERN.test(filePath)) {
        continue;
      }
      seen.add(resolve(filePath));
      validateDeclarativeFile(report, repoRoot, filePath, type);
    }
  }

  // 3. Extra declarative files from extensions.yaml.
  for (const ref of declarativeRefs) {
    const refPath = resolve(excaliburDir, ref);
    if (seen.has(refPath)) {
      continue;
    }
    if (!existsSync(refPath)) {
      report.errors.push({
        file: relative(repoRoot, extensionsYaml),
        message: `declarative entry references missing file ${ref}`,
      });
      continue;
    }
    validateDeclarativeFile(report, repoRoot, refPath, undefined);
  }

  // 4. Extension directories (.excalibur/extensions/* + extensions.yaml local list).
  const extensionDirs = new Set<string>(listDirs(join(excaliburDir, 'extensions')).map((d) => resolve(d)));
  for (const local of localDirs) {
    const localPath = resolve(excaliburDir, local);
    if (!existsSync(localPath)) {
      report.errors.push({
        file: relative(repoRoot, extensionsYaml),
        message: `local entry references missing directory ${local}`,
      });
      continue;
    }
    extensionDirs.add(localPath);
  }
  for (const dir of extensionDirs) {
    validateExtensionDir(report, repoRoot, dir);
  }

  return report;
}
