import type { Contribution } from '@excalibur/extension-runtime';

/**
 * A built-in extension pack: a validated extension manifest plus the
 * already-materialized contributions it provides. Built-ins skip the
 * file-based declarative loader — their definitions come straight from the
 * `@excalibur/workflow-schema` constants (single source of truth) — but they
 * flow through the exact same `ContributionRegistry` as project extensions
 * (extensions spec §11, rule 8). The type is owned by
 * `@excalibur/extension-runtime` (`loadExtensions` consumes it) and
 * re-exported here for convenience.
 */
export type { BuiltInExtensionPack } from '@excalibur/extension-runtime';

/** Shared version string for every built-in pack (tracks the package version). */
export const BUILT_IN_EXTENSION_VERSION = '0.1.0';

/**
 * Build one `built_in` contribution. Definitions are passed by reference:
 * packs wrap the catalog constants, they never duplicate their content.
 */
export function builtInContribution(
  extensionId: string,
  kind: Contribution['kind'],
  id: string,
  definition: unknown,
): Contribution {
  return { kind, id, extensionId, source: 'built_in', definition };
}
