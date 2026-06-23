import { BUILT_IN_EXTENSIONS } from '@excalibur/built-in-extensions';
import {
  loadExtensions,
  type ExtensionPolicy,
  type ExtensionRegistry,
} from '@excalibur/extension-runtime';
import type { ExcaliburConfig, McpServerConfig } from '@excalibur/shared';
import type { WorkflowDefinition } from '@excalibur/workflow-schema';

/**
 * Derives the extension-load policy (P2.18) from `config.extensions`. Returns
 * undefined (warn-only) when no `enforce` is set, so behavior is unchanged
 * unless the project opts in.
 */
export function extensionPolicyFromConfig(config: ExcaliburConfig): ExtensionPolicy | undefined {
  const ext = config.extensions;
  if (ext === undefined || ext.enforce !== true) {
    return undefined;
  }
  return {
    enforce: true,
    ...(ext.allowedCapabilities !== undefined
      ? { allowedCapabilities: ext.allowedCapabilities }
      : {}),
    ...(ext.deniedCapabilities !== undefined ? { deniedCapabilities: ext.deniedCapabilities } : {}),
    ...(ext.locks !== undefined ? { locks: ext.locks } : {}),
  };
}

/**
 * Creates the extension host for a repository (Build Contract §4.6):
 * built-in packs are registered first, then project declarative files and
 * local programmatic extensions, so project files override built-ins with
 * zero special-casing. The workflow/methodology catalog used by
 * `selectWorkflow`, init and the CLI must come from `registry.contributions`.
 */
export function createExtensionHost(
  repoRoot: string,
  policy?: ExtensionPolicy,
): Promise<ExtensionRegistry> {
  return loadExtensions({
    repoRoot,
    builtIns: BUILT_IN_EXTENSIONS,
    ...(policy !== undefined ? { policy } : {}),
  });
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

/**
 * Collects the MCP servers contributed by loaded extensions' manifests (EXT-6),
 * keyed by name. Later extensions in load order override earlier ones on a name
 * clash (matching the contribution-source precedence). Failed extensions never
 * contribute.
 */
export function collectExtensionMcpServers(
  registry: ExtensionRegistry,
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  for (const extension of registry.extensions()) {
    if (extension.status !== 'loaded') {
      continue;
    }
    for (const spec of extension.manifest.contributes?.mcpServers ?? []) {
      servers[spec.name] = {
        command: spec.command,
        ...(spec.args !== undefined ? { args: spec.args } : {}),
        ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
        ...(spec.env !== undefined ? { env: spec.env } : {}),
      };
    }
  }
  return servers;
}

/**
 * Returns `config` with extension-contributed MCP servers merged into
 * `mcp.servers` (EXT-6). The repo's OWN `config.mcp.servers` always WINS on a
 * name clash — an extension never overrides a server the user configured
 * explicitly. No contributions → `config` is returned unchanged (MCP stays
 * exactly as the repo configured it, including off).
 */
export function withExtensionMcpServers(
  config: ExcaliburConfig,
  registry: ExtensionRegistry,
): ExcaliburConfig {
  const extensionServers = collectExtensionMcpServers(registry);
  if (Object.keys(extensionServers).length === 0) {
    return config;
  }
  const merged: Record<string, McpServerConfig> = {
    ...extensionServers,
    ...(config.mcp?.servers ?? {}),
  };
  return { ...config, mcp: { ...config.mcp, servers: merged } };
}
