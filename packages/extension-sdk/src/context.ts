import type {
  Contribution,
  ContributionRegistry,
  HookRegistry,
} from '@excalibur/extension-runtime';
import type { ModelProviderAdapter } from '@excalibur/model-gateway';
import type { AgentAdapter } from '@excalibur/agent-runtime';
import type { WorkItemProvider } from '@excalibur/work-items';
import type { z } from 'zod';
import {
  methodologySchema,
  validateMethodology,
  validateWorkflowDefinition,
  workflowDefinitionSchema,
} from '@excalibur/workflow-schema';
import { WorkflowValidationError } from '@excalibur/shared';
import { ExtensionDefinitionError } from './errors';
import { createNoopLogger, type ExtensionConfig, type ExtensionLogger } from './logger';
import type { CommunicationProvider } from './interfaces/communication';
import type { AgentTool } from './interfaces/tools';
import type { ContextSource } from './interfaces/context-source';
import type { PolicyEvaluator } from './interfaces/policy';
import type { ReportGenerator } from './interfaces/reports';
import type { Exporter } from './interfaces/exporters';

/**
 * `ExtensionContext` and the typed registries handed to programmatic
 * extensions (Build Contract §4.6d, extensions-spec.md §5).
 *
 * Every registry is a thin typed wrapper over
 * `ContributionRegistry.register`: it validates the contribution's identity,
 * stamps the owning extension id and source, and delegates. Conflict and
 * override rules stay in `@excalibur/extension-runtime`.
 */

/** Where a contribution comes from; mirrors `Contribution['source']`. */
export type ExtensionSource = Contribution['source'];

/** Methodology definition as authored (before schema normalization). */
export type MethodologyInput = z.input<typeof methodologySchema>;

/** Workflow definition as authored (before schema normalization). */
export type WorkflowDefinitionInput = z.input<typeof workflowDefinitionSchema>;

/** Shared binding the registry wrappers delegate through. */
interface RegistryBinding {
  readonly extensionId: string;
  readonly source: ExtensionSource;
  readonly contributions: ContributionRegistry;
}

function requireNonEmptyString(value: unknown, what: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ExtensionDefinitionError(`${what} requires a non-empty string "${field}"`, {
      field,
      received: typeof value,
    });
  }
  return value;
}

function requireFunctions(value: object, what: string, methods: readonly string[]): void {
  const record = value as Record<string, unknown>;
  for (const method of methods) {
    if (typeof record[method] !== 'function') {
      throw new ExtensionDefinitionError(`${what} must implement ${method}()`, {
        method,
      });
    }
  }
}

function requireObject(value: unknown, what: string): object {
  if (typeof value !== 'object' || value === null) {
    throw new ExtensionDefinitionError(`${what} must be an object`, {
      received: value === null ? 'null' : typeof value,
    });
  }
  return value;
}

function register(
  binding: RegistryBinding,
  kind: Contribution['kind'],
  id: string,
  payload: { definition?: unknown; value?: unknown },
): void {
  const contribution: Contribution = {
    kind,
    id,
    extensionId: binding.extensionId,
    source: binding.source,
    ...payload,
  };
  binding.contributions.register(contribution);
}

/** Registers declarative methodology definitions (kind `methodology`). */
export class MethodologyRegistry {
  constructor(private readonly binding: RegistryBinding) {}

  register(definition: MethodologyInput): void {
    const result = validateMethodology(definition);
    if (!result.success || result.data === undefined) {
      throw new WorkflowValidationError(
        `Invalid methodology contributed by extension "${this.binding.extensionId}": ${(result.errors ?? ['unknown error']).join('; ')}`,
        { extensionId: this.binding.extensionId, errors: result.errors },
      );
    }
    register(this.binding, 'methodology', result.data.id, { definition: result.data });
  }
}

/** Registers declarative workflow definitions (kind `workflow`). */
export class WorkflowRegistry {
  constructor(private readonly binding: RegistryBinding) {}

  register(definition: WorkflowDefinitionInput): void {
    const result = validateWorkflowDefinition(definition);
    if (!result.success || result.data === undefined) {
      throw new WorkflowValidationError(
        `Invalid workflow contributed by extension "${this.binding.extensionId}": ${(result.errors ?? ['unknown error']).join('; ')}`,
        { extensionId: this.binding.extensionId, errors: result.errors },
      );
    }
    register(this.binding, 'workflow', result.data.id, { definition: result.data });
  }
}

/** Registers work item providers (kind `work_item_provider`). */
export class WorkItemProviderRegistry {
  constructor(private readonly binding: RegistryBinding) {}

  registerProvider(provider: WorkItemProvider): void {
    const obj = requireObject(provider, 'WorkItemProvider');
    const type = requireNonEmptyString(provider.type, 'WorkItemProvider', 'type');
    requireFunctions(obj, `WorkItemProvider "${type}"`, [
      'getWorkItem',
      'listWorkItems',
      'addComment',
      'updateStatus',
      'linkPullRequest',
      'validateCredentials',
    ]);
    register(this.binding, 'work_item_provider', type, { value: provider });
  }
}

/** Registers communication providers (kind `communication_provider`). */
export class CommunicationProviderRegistry {
  constructor(private readonly binding: RegistryBinding) {}

  registerProvider(provider: CommunicationProvider): void {
    const obj = requireObject(provider, 'CommunicationProvider');
    const type = requireNonEmptyString(provider.type, 'CommunicationProvider', 'type');
    requireFunctions(obj, `CommunicationProvider "${type}"`, [
      'postMessage',
      'postThreadReply',
      'getThreadReplies',
      'validateCredentials',
    ]);
    register(this.binding, 'communication_provider', type, { value: provider });
  }
}

/** Registers model provider adapters (kind `model_provider`). */
export class ModelProviderRegistry {
  constructor(private readonly binding: RegistryBinding) {}

  registerProvider(provider: ModelProviderAdapter): void {
    const obj = requireObject(provider, 'ModelProviderAdapter');
    const name = requireNonEmptyString(provider.name, 'ModelProviderAdapter', 'name');
    requireFunctions(obj, `ModelProviderAdapter "${name}"`, ['chat', 'stream']);
    register(this.binding, 'model_provider', name, { value: provider });
  }
}

/** Registers agent adapters (kind `agent_adapter`). */
export class AgentAdapterRegistry {
  constructor(private readonly binding: RegistryBinding) {}

  registerAdapter(adapter: AgentAdapter): void {
    const obj = requireObject(adapter, 'AgentAdapter');
    const id = requireNonEmptyString(adapter.id, 'AgentAdapter', 'id');
    requireFunctions(obj, `AgentAdapter "${id}"`, ['detect', 'run']);
    register(this.binding, 'agent_adapter', id, { value: adapter });
  }
}

/** Registers agent tools (kind `tool`). */
export class ToolRegistry {
  constructor(private readonly binding: RegistryBinding) {}

  registerTool(tool: AgentTool): void {
    const obj = requireObject(tool, 'AgentTool');
    const name = requireNonEmptyString(tool.name, 'AgentTool', 'name');
    requireNonEmptyString(tool.description, `AgentTool "${name}"`, 'description');
    requireFunctions(obj, `AgentTool "${name}"`, ['execute']);
    register(this.binding, 'tool', name, { value: tool });
  }
}

/** Registers context sources (kind `context_source`). */
export class ContextSourceRegistry {
  constructor(private readonly binding: RegistryBinding) {}

  registerSource(source: ContextSource): void {
    const obj = requireObject(source, 'ContextSource');
    const id = requireNonEmptyString(source.id, 'ContextSource', 'id');
    requireFunctions(obj, `ContextSource "${id}"`, ['search', 'load']);
    register(this.binding, 'context_source', id, { value: source });
  }
}

/** Registers policy evaluators (kind `policy_evaluator`). */
export class PolicyRegistry {
  constructor(private readonly binding: RegistryBinding) {}

  registerEvaluator(evaluator: PolicyEvaluator): void {
    const obj = requireObject(evaluator, 'PolicyEvaluator');
    const id = requireNonEmptyString(evaluator.id, 'PolicyEvaluator', 'id');
    requireFunctions(obj, `PolicyEvaluator "${id}"`, ['evaluate']);
    register(this.binding, 'policy_evaluator', id, { value: evaluator });
  }
}

/**
 * Registers report generators. The contribution kind catalog has no separate
 * programmatic report kind, so generators are registered under
 * `report_template` with the generator in `value` (declarative templates use
 * `definition`), keeping both addressable through one registry namespace.
 */
export class ReportRegistry {
  constructor(private readonly binding: RegistryBinding) {}

  registerGenerator(generator: ReportGenerator): void {
    const obj = requireObject(generator, 'ReportGenerator');
    const id = requireNonEmptyString(generator.id, 'ReportGenerator', 'id');
    requireFunctions(obj, `ReportGenerator "${id}"`, ['generate']);
    register(this.binding, 'report_template', id, { value: generator });
  }
}

/** Registers exporters (kind `exporter`). */
export class ExporterRegistry {
  constructor(private readonly binding: RegistryBinding) {}

  registerExporter(exporter: Exporter): void {
    const obj = requireObject(exporter, 'Exporter');
    const id = requireNonEmptyString(exporter.id, 'Exporter', 'id');
    requireFunctions(obj, `Exporter "${id}"`, ['export']);
    register(this.binding, 'exporter', id, { value: exporter });
  }
}

/** The context handed to an extension's `register()` (extensions-spec.md §5). */
export interface ExtensionContext {
  methodologies: MethodologyRegistry;
  workflows: WorkflowRegistry;
  workItems: WorkItemProviderRegistry;
  communication: CommunicationProviderRegistry;
  models: ModelProviderRegistry;
  agents: AgentAdapterRegistry;
  tools: ToolRegistry;
  contextSources: ContextSourceRegistry;
  policies: PolicyRegistry;
  reports: ReportRegistry;
  exporters: ExporterRegistry;
  hooks: HookRegistry;
  logger: ExtensionLogger;
  config: ExtensionConfig;
}

/** Host-side input to build an `ExtensionContext`. */
export interface CreateExtensionContextInput {
  /** Id of the extension the context is created for. */
  extensionId: string;
  /** The runtime's contribution registry all registrations delegate to. */
  contributions: ContributionRegistry;
  /** The runtime's hook registry, shared across extensions. */
  hooks: HookRegistry;
  /** Source attributed to every contribution; defaults to `local`. */
  source?: ExtensionSource;
  /** Host logger; defaults to a silent no-op (packages never print). */
  logger?: ExtensionLogger;
  /** Configuration values resolved for the extension; defaults to `{}`. */
  config?: ExtensionConfig;
}

/**
 * Builds the `ExtensionContext` a host passes to `extension.register()`.
 * Exposed so hosts (extension loader, tests) and extension authors share one
 * implementation of the registry wiring.
 */
export function createExtensionContext(input: CreateExtensionContextInput): ExtensionContext {
  const extensionId = requireNonEmptyString(
    input.extensionId,
    'createExtensionContext',
    'extensionId',
  );
  const binding: RegistryBinding = {
    extensionId,
    source: input.source ?? 'local',
    contributions: input.contributions,
  };
  return {
    methodologies: new MethodologyRegistry(binding),
    workflows: new WorkflowRegistry(binding),
    workItems: new WorkItemProviderRegistry(binding),
    communication: new CommunicationProviderRegistry(binding),
    models: new ModelProviderRegistry(binding),
    agents: new AgentAdapterRegistry(binding),
    tools: new ToolRegistry(binding),
    contextSources: new ContextSourceRegistry(binding),
    policies: new PolicyRegistry(binding),
    reports: new ReportRegistry(binding),
    exporters: new ExporterRegistry(binding),
    hooks: input.hooks,
    logger: input.logger ?? createNoopLogger(),
    config: input.config ?? {},
  };
}
