import { ContributionRegistry, type ExtensionRegistry } from '@excalibur/extension-runtime';
import { createNoopLogger, type ExtensionConfig, type ExtensionLogger } from '../logger';
import { isExcaliburExtension } from '../define-extension';
import { createExtensionContext } from '../context';
import { isAgentTool, type AgentTool } from '../interfaces/tools';

/**
 * Extension activation host (extensions-spec.md §5).
 *
 * The runtime loader (`@excalibur/extension-runtime`) only LOADS and validates a
 * compiled extension entrypoint — it never runs the extension's `register(ctx)`.
 * This helper performs that activation: it invokes each loaded programmatic
 * extension's `register(ctx)` and harvests the contributions it produces. The
 * first consumer is the native agent loop, which executes the harvested tools.
 *
 * Each extension activates into its OWN scratch `ContributionRegistry`, NOT the
 * shared one, on purpose: the loader pre-registers manifest-declared programmatic
 * contributions into the shared registry keyed by their declared name with the
 * extension instance as the value, and a same-source duplicate would silently
 * drop the real tool the extension registers here. Activating into a scratch
 * registry sidesteps that collision; hooks still target the SHARED hook registry
 * so an extension's event handlers reach live runs.
 */
export interface ActivateExtensionsOptions {
  /** Host logger handed to each extension's context (defaults to a no-op). */
  logger?: ExtensionLogger;
  /** Resolves per-extension configuration by id (defaults to `{}`). */
  config?: (extensionId: string) => ExtensionConfig;
}

/** The result of activating every loaded extension. */
export interface ActivationResult {
  /** Executable tools contributed across all activated extensions. */
  tools: AgentTool[];
  /** Activation warnings (a failed/duplicate activation never throws). */
  warnings: string[];
}

/**
 * Activates every loaded programmatic extension and returns the agent tools they
 * contribute. A faulty extension is recorded as a warning and skipped — one bad
 * extension never breaks activation. Tool names are global: the first extension
 * to register a name wins, later duplicates are dropped with a warning.
 */
export async function activateExtensions(
  registry: ExtensionRegistry,
  options: ActivateExtensionsOptions = {},
): Promise<ActivationResult> {
  const tools: AgentTool[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const extension of registry.extensions()) {
    if (extension.status !== 'loaded' || extension.instance === undefined) {
      continue;
    }
    if (!isExcaliburExtension(extension.instance)) {
      continue;
    }
    const id = extension.manifest.id;
    const scratch = new ContributionRegistry();
    const ctx = createExtensionContext({
      extensionId: id,
      contributions: scratch,
      hooks: registry.hooks,
      source: extension.source,
      logger: options.logger ?? createNoopLogger(),
      config: options.config?.(id) ?? {},
    });
    try {
      await extension.instance.register(ctx);
    } catch (error) {
      warnings.push(`Extension '${id}' failed to activate: ${errorMessage(error)}`);
      continue;
    }
    for (const contribution of scratch.list('tool')) {
      if (!isAgentTool(contribution.value)) {
        continue;
      }
      const tool = contribution.value;
      if (seen.has(tool.name)) {
        warnings.push(
          `Tool '${tool.name}' from extension '${id}' was ignored — a tool with that name is already contributed.`,
        );
        continue;
      }
      seen.add(tool.name);
      tools.push(tool);
    }
    for (const warning of scratch.warnings()) {
      warnings.push(`[${id}] ${warning}`);
    }
  }

  return { tools, warnings };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
