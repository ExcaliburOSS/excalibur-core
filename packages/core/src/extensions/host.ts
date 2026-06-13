import { BUILT_IN_EXTENSIONS } from '@excalibur/built-in-extensions';
import { loadExtensions, type ExtensionRegistry } from '@excalibur/extension-runtime';
import type { WorkflowDefinition } from '@excalibur/workflow-schema';

/**
 * Creates the extension host for a repository (Build Contract §4.6):
 * built-in packs are registered first, then project declarative files and
 * local programmatic extensions, so project files override built-ins with
 * zero special-casing. The workflow/methodology catalog used by
 * `selectWorkflow`, init and the CLI must come from `registry.contributions`.
 */
export function createExtensionHost(repoRoot: string): Promise<ExtensionRegistry> {
  return loadExtensions({ repoRoot, builtIns: BUILT_IN_EXTENSIONS });
}

/** Catalog entry shape consumed by `selectWorkflow` (Build Contract §4.6). */
export interface WorkflowCatalogEntry {
  id: string;
  definition: WorkflowDefinition;
}

/**
 * Convenience: turns a loaded registry into the `selectWorkflow` catalog
 * (project-level overrides already applied by the contribution registry).
 */
export function workflowCatalog(registry: ExtensionRegistry): WorkflowCatalogEntry[] {
  return registry.contributions
    .workflows()
    .map((definition) => ({ id: definition.id, definition }));
}
