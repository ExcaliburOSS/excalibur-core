import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, relative, resolve } from 'node:path';
import {
  parseDeclarativeMarkdown,
  parseDeclarativeYaml,
  type DeclarativeDefinition,
  type DeclarativeType,
} from '@excalibur/declarative-schemas';
import { isExcaliburError, WorkflowValidationError } from '@excalibur/shared';
import { type ProgrammaticContributionKind } from './contributions';
import { loadExtensionsFile, type ExtensionsFileConfig } from './extensions-file';
import {
  loadManifest,
  type ExtensionContributions,
  type ExtensionManifest,
} from './manifest';
import { validatePermissions } from './permissions';
import {
  ExtensionRegistry,
  type BuiltInExtensionPack,
  type LoadedExtension,
} from './registry';

/**
 * Extension loader (extensions spec §7). Load order:
 *
 * 1. built-in extension packs;
 * 2. project declarative files (scan of the 10 `.excalibur/` declarative
 *    directories plus the `extensions.yaml` `declarative:` list);
 * 3. local programmatic extensions (`extensions.yaml` `local:` directories and
 *    `.excalibur/extensions/*` directories carrying a manifest) — compiled
 *    entrypoints are `require`d; failures are recorded per-extension, never
 *    thrown. Manifests with `kind: declarative` carry no code: they are
 *    project-level declarative content (spec §7 bucket 2) and register with
 *    source `project`, so the project-overrides-built-in conflict rule
 *    applies to them;
 * 4. installed npm extensions (later milestone);
 * 5. enterprise-managed extensions (later milestone).
 *
 * `enabled`/`disabled` from `.excalibur/extensions.yaml` are respected: a
 * disabled extension is skipped entirely (M1 treats every discovered
 * extension as enabled unless disabled).
 */
export interface LoadExtensionsInput {
  repoRoot: string;
  builtIns: ReadonlyArray<BuiltInExtensionPack>;
}

/** Synthetic extension id grouping loose project declarative files. */
export const PROJECT_EXTENSION_ID = 'project';

const MANIFEST_FILE_NAME = 'excalibur.extension.yaml';

/** The 10 project declarative directories and the type each one implies (spec §2). */
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

const DIR_NAME_TO_TYPE: ReadonlyMap<string, DeclarativeType> = new Map(
  PROJECT_DECLARATIVE_DIRS.map(({ dirName, type }) => [dirName, type]),
);

/** Manifest `contributes` keys that reference declarative files. */
const DECLARATIVE_CONTRIBUTES_KEYS: ReadonlyArray<{
  key: keyof ExtensionContributions;
  type: DeclarativeType;
}> = [
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

/**
 * Manifest `contributes` keys that name programmatic contributions.
 * `communicationHandlers` is accepted by the manifest schema but has no
 * contribution kind in M1, so it is not auto-registered.
 */
const PROGRAMMATIC_CONTRIBUTES_KEYS: ReadonlyArray<{
  key: keyof ExtensionContributions;
  kind: ProgrammaticContributionKind;
}> = [
  { key: 'workItemProviders', kind: 'work_item_provider' },
  { key: 'communicationProviders', kind: 'communication_provider' },
  { key: 'modelProviders', kind: 'model_provider' },
  { key: 'agentAdapters', kind: 'agent_adapter' },
  { key: 'tools', kind: 'tool' },
  { key: 'contextSources', kind: 'context_source' },
  { key: 'exporters', kind: 'exporter' },
  { key: 'policyEvaluators', kind: 'policy_evaluator' },
  { key: 'vcsProviders', kind: 'vcs_provider' },
  { key: 'enterpriseSyncProviders', kind: 'enterprise_sync_provider' },
];

const YAML_EXTENSION_PATTERN = /\.ya?ml$/i;
const MARKDOWN_EXTENSION_PATTERN = /\.(md|markdown)$/i;

/** Load every extension source for a repository into one registry. */
export async function loadExtensions(input: LoadExtensionsInput): Promise<ExtensionRegistry> {
  const registry = new ExtensionRegistry();
  const excaliburDir = join(input.repoRoot, '.excalibur');

  // A broken extensions.yaml must not take the whole runtime down: record a
  // warning and continue with defaults (everything enabled).
  let extensionsFile: ExtensionsFileConfig = {};
  try {
    extensionsFile = loadExtensionsFile(input.repoRoot);
  } catch (error) {
    registry.contributions.addWarning(errorMessage(error));
  }

  const disabled = new Set(extensionsFile.disabled ?? []);
  for (const id of extensionsFile.enabled ?? []) {
    if (disabled.has(id)) {
      registry.contributions.addWarning(
        `Extension '${id}' is listed in both 'enabled' and 'disabled' in .excalibur/extensions.yaml — 'disabled' wins.`,
      );
    }
  }

  loadBuiltIns(registry, input.builtIns, disabled);
  loadProjectDeclaratives(registry, input.repoRoot, excaliburDir, extensionsFile, disabled);
  loadLocalExtensions(registry, input.repoRoot, excaliburDir, extensionsFile, disabled);

  return registry;
}

// --- 1. built-ins -----------------------------------------------------------

function loadBuiltIns(
  registry: ExtensionRegistry,
  builtIns: ReadonlyArray<BuiltInExtensionPack>,
  disabled: ReadonlySet<string>,
): void {
  for (const pack of builtIns) {
    if (disabled.has(pack.manifest.id)) {
      continue;
    }
    registry.addExtension({
      manifest: pack.manifest,
      source: 'built_in',
      dir: null,
      status: 'loaded',
    });
    for (const warning of validatePermissions(pack.manifest)) {
      registry.contributions.addWarning(warning);
    }
    for (const contribution of pack.contributions) {
      // Force the source/extensionId invariants so override rules always hold.
      registry.contributions.register({
        ...contribution,
        source: 'built_in',
        extensionId: pack.manifest.id,
      });
    }
  }
}

// --- 2. project declarative files -------------------------------------------

function loadProjectDeclaratives(
  registry: ExtensionRegistry,
  repoRoot: string,
  excaliburDir: string,
  extensionsFile: ExtensionsFileConfig,
  disabled: ReadonlySet<string>,
): void {
  if (disabled.has(PROJECT_EXTENSION_ID)) {
    return;
  }

  const candidates: Array<{ absPath: string; expectedType?: DeclarativeType }> = [];
  const seen = new Set<string>();
  const pushCandidate = (absPath: string, expectedType?: DeclarativeType): void => {
    const key = resolve(absPath);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push({ absPath: key, ...(expectedType !== undefined ? { expectedType } : {}) });
  };

  for (const { dirName, type } of PROJECT_DECLARATIVE_DIRS) {
    const dir = join(excaliburDir, dirName);
    for (const fileName of listFiles(dir)) {
      // `.excalibur/models/providers.yaml` is the model provider config
      // (oss-spec §14), not a declarative model_routing definition.
      if (dirName === 'models' && fileName === 'providers.yaml') {
        continue;
      }
      const isYaml = YAML_EXTENSION_PATTERN.test(fileName);
      const isMarkdown = MARKDOWN_EXTENSION_PATTERN.test(fileName);
      const markdownAllowed = type === 'prompt_template' || type === 'artifact_template';
      if (!isYaml && !(isMarkdown && markdownAllowed)) {
        continue;
      }
      pushCandidate(join(dir, fileName), type);
    }
  }

  for (const declared of extensionsFile.declarative ?? []) {
    const absPath = resolve(excaliburDir, declared);
    if (seen.has(absPath)) {
      continue;
    }
    if (!existsSync(absPath)) {
      registry.contributions.addWarning(
        `Declarative file '${declared}' listed in .excalibur/extensions.yaml was not found at ${absPath}.`,
      );
      continue;
    }
    pushCandidate(absPath, inferTypeFromPath(absPath));
  }

  if (candidates.length === 0) {
    return;
  }

  registry.addExtension({
    manifest: {
      id: PROJECT_EXTENSION_ID,
      name: 'Project declarative files (.excalibur/)',
      version: '0.0.0',
      kind: 'declarative',
    },
    source: 'project',
    dir: excaliburDir,
    status: 'loaded',
  });

  for (const candidate of candidates) {
    try {
      const definition = parseDeclarativeFile(candidate.absPath, candidate.expectedType);
      // `type` is an optional discriminator on workflow/methodology files;
      // fall back to the directory-implied type when it is omitted.
      const kind = definition.type ?? candidate.expectedType;
      if (kind === undefined) {
        throw new WorkflowValidationError('the file does not declare a "type" field');
      }
      registry.contributions.register({
        kind,
        id: definition.id,
        extensionId: PROJECT_EXTENSION_ID,
        source: 'project',
        definition,
      });
    } catch (error) {
      registry.contributions.addWarning(
        `Failed to load ${relative(repoRoot, candidate.absPath)}: ${errorMessage(error)}`,
      );
    }
  }
}

// --- 3. local programmatic extensions ----------------------------------------

function loadLocalExtensions(
  registry: ExtensionRegistry,
  repoRoot: string,
  excaliburDir: string,
  extensionsFile: ExtensionsFileConfig,
  disabled: ReadonlySet<string>,
): void {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const pushDir = (dir: string): void => {
    const key = resolve(dir);
    if (!seen.has(key)) {
      seen.add(key);
      dirs.push(key);
    }
  };

  for (const entry of extensionsFile.local ?? []) {
    // Paths are relative to `.excalibur/` (where extensions.yaml lives);
    // fall back to repo-root-relative for convenience.
    const primary = resolve(excaliburDir, entry);
    const fallback = resolve(repoRoot, entry);
    if (existsSync(join(primary, MANIFEST_FILE_NAME))) {
      pushDir(primary);
    } else if (existsSync(join(fallback, MANIFEST_FILE_NAME))) {
      pushDir(fallback);
    } else {
      pushDir(primary); // report the error against the canonical location
    }
  }

  const extensionsDir = join(excaliburDir, 'extensions');
  for (const entry of listDirectories(extensionsDir)) {
    const dir = join(extensionsDir, entry);
    if (existsSync(join(dir, MANIFEST_FILE_NAME))) {
      pushDir(dir);
    }
  }

  for (const dir of dirs) {
    loadLocalExtension(registry, dir, disabled);
  }
}

function loadLocalExtension(
  registry: ExtensionRegistry,
  dir: string,
  disabled: ReadonlySet<string>,
): void {
  const manifestPath = join(dir, MANIFEST_FILE_NAME);
  let manifest: ExtensionManifest;
  try {
    manifest = loadManifest(manifestPath);
  } catch (error) {
    registry.addExtension({
      manifest: fallbackManifest(dir),
      source: 'local',
      dir,
      status: 'error',
      error: errorMessage(error),
    });
    return;
  }

  if (disabled.has(manifest.id)) {
    return;
  }

  // A `kind: declarative` manifest ships no code — it is project-level
  // declarative content (extensions spec §7 bucket 2), so its contributions
  // take the `project` source and the project-overrides-built-in rule applies.
  // Programmatic and mixed extensions stay `local`.
  const source = manifest.kind === 'declarative' ? ('project' as const) : ('local' as const);

  const errors: string[] = [];

  for (const { key, type } of DECLARATIVE_CONTRIBUTES_KEYS) {
    for (const relPath of manifest.contributes?.[key] ?? []) {
      const absPath = resolve(dir, relPath);
      try {
        const definition = parseDeclarativeFile(absPath, type);
        if (definition.type !== undefined && definition.type !== type) {
          throw new WorkflowValidationError(
            `expected a ${type} definition (referenced from contributes.${String(key)}) but the file defines a ${definition.type}`,
          );
        }
        registry.contributions.register({
          kind: type,
          id: definition.id,
          extensionId: manifest.id,
          source,
          definition,
        });
      } catch (error) {
        errors.push(`${relPath}: ${errorMessage(error)}`);
      }
    }
  }

  let instance: unknown;
  if (manifest.kind === 'programmatic' || manifest.kind === 'mixed') {
    // The manifest schema guarantees an entrypoint for these kinds.
    const entrypoint = manifest.entrypoint ?? 'dist/index.js';
    const entrypointPath = resolve(dir, entrypoint);
    if (!existsSync(entrypointPath)) {
      errors.push(
        `entrypoint not found: ${entrypoint} — build the extension first (compiled JS is required in M1)`,
      );
    } else {
      try {
        const exported = unwrapModuleDefault(requireEntrypoint(entrypointPath));
        if (!isExtensionInstance(exported)) {
          errors.push(
            `entrypoint ${entrypoint} did not export an Excalibur extension — export the result of defineExtension(...) as the default export`,
          );
        } else {
          instance = exported;
          if (exported.id !== manifest.id) {
            registry.contributions.addWarning(
              `Extension '${manifest.id}' entrypoint exports id '${exported.id}' — the manifest id wins.`,
            );
          }
          for (const { key, kind } of PROGRAMMATIC_CONTRIBUTES_KEYS) {
            for (const name of manifest.contributes?.[key] ?? []) {
              registry.contributions.register({
                kind,
                id: name,
                extensionId: manifest.id,
                source: 'local',
                value: exported,
              });
            }
          }
        }
      } catch (error) {
        errors.push(`failed to load entrypoint ${entrypoint}: ${errorMessage(error)}`);
      }
    }
  }

  for (const warning of validatePermissions(manifest)) {
    registry.contributions.addWarning(warning);
  }

  const loaded: LoadedExtension = {
    manifest,
    source,
    dir,
    status: errors.length > 0 ? 'error' : 'loaded',
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
    ...(instance !== undefined ? { instance } : {}),
  };
  registry.addExtension(loaded);
}

// --- helpers -----------------------------------------------------------------

function parseDeclarativeFile(
  absPath: string,
  expectedType?: DeclarativeType,
): DeclarativeDefinition {
  const content = readFileSync(absPath, 'utf8');
  if (MARKDOWN_EXTENSION_PATTERN.test(absPath)) {
    return parseDeclarativeMarkdown(absPath, content);
  }
  return expectedType === undefined
    ? parseDeclarativeYaml(content)
    : parseDeclarativeYaml(content, expectedType);
}

function inferTypeFromPath(absPath: string): DeclarativeType | undefined {
  const segments = absPath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment === undefined) {
      continue;
    }
    const type = DIR_NAME_TO_TYPE.get(segment);
    if (type !== undefined) {
      return type;
    }
  }
  return undefined;
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

function listDirectories(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function fallbackManifest(dir: string): ExtensionManifest {
  return {
    id: basename(dir),
    name: basename(dir),
    version: '0.0.0',
    kind: 'declarative',
  };
}

/** Load a compiled entrypoint in a way that works from both CJS and ESM builds. */
function requireEntrypoint(absPath: string): unknown {
  const requireFromEntrypoint = createRequire(absPath);
  return requireFromEntrypoint(absPath) as unknown;
}

function unwrapModuleDefault(moduleExports: unknown): unknown {
  if (
    typeof moduleExports === 'object' &&
    moduleExports !== null &&
    'default' in moduleExports &&
    (moduleExports as { default?: unknown }).default !== undefined
  ) {
    return (moduleExports as { default: unknown }).default;
  }
  return moduleExports;
}

function isExtensionInstance(value: unknown): value is {
  id: string;
  register: (...args: unknown[]) => unknown;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { register?: unknown }).register === 'function'
  );
}

function errorMessage(error: unknown): string {
  if (isExcaliburError(error)) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
