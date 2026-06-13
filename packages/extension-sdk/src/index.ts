/**
 * @excalibur/extension-sdk — TypeScript SDK for programmatic Excalibur
 * extensions: `defineExtension`, `ExtensionContext` with its typed
 * registries, and the contribution interfaces owned by this package
 * (Build Contract §4.6d, docs/spec/extensions-spec.md §5).
 *
 * Reused contribution interfaces keep their owning package:
 * `WorkItemProvider` (@excalibur/work-items), `ModelProviderAdapter`
 * (@excalibur/model-gateway), `AgentAdapter` (@excalibur/agent-runtime).
 */

export { defineExtension, isExcaliburExtension, registerExtension } from './define-extension';
export type {
  ExtensionDefinition,
  ExcaliburExtension,
  RegisterExtensionInput,
} from './define-extension';

export {
  createExtensionContext,
  MethodologyRegistry,
  WorkflowRegistry,
  WorkItemProviderRegistry,
  CommunicationProviderRegistry,
  ModelProviderRegistry,
  AgentAdapterRegistry,
  ToolRegistry,
  ContextSourceRegistry,
  PolicyRegistry,
  ReportRegistry,
  ExporterRegistry,
} from './context';
export type {
  ExtensionContext,
  CreateExtensionContextInput,
  ExtensionSource,
  MethodologyInput,
  WorkflowDefinitionInput,
} from './context';

export { createNoopLogger } from './logger';
export type { ExtensionLogger, ExtensionConfig } from './logger';

export { ExtensionDefinitionError } from './errors';

export type {
  CommunicationProvider,
  PostMessageInput,
  PostThreadReplyInput,
  GetThreadRepliesInput,
  PostMessageResult,
  ThreadReply,
} from './interfaces/communication';
export type { AgentTool, ToolContext, ToolResult } from './interfaces/tools';
export type {
  ContextSource,
  ContextSearchInput,
  ContextLoadInput,
  ContextDocument,
} from './interfaces/context-source';
export { policyDecisionResultSchema } from './interfaces/policy';
export type { PolicyEvaluator, PolicyContext, PolicyDecision } from './interfaces/policy';
export type { ReportGenerator, ReportInput, ReportOutput } from './interfaces/reports';
export type { Exporter, ExportInput, ExportResult } from './interfaces/exporters';

// Convenience re-exports so extension authors import one package. The
// reused contribution interfaces keep their owning package; the hook names
// and registries live in @excalibur/extension-runtime (single source of truth).
export type { WorkItemProvider } from '@excalibur/work-items';
export type { ModelProviderAdapter } from '@excalibur/model-gateway';
export type { AgentAdapter, AgentRunInput } from '@excalibur/agent-runtime';
export { ContributionRegistry, EXCALIBUR_HOOKS, HookRegistry } from '@excalibur/extension-runtime';
export type {
  Contribution,
  ContributionKind,
  ContributionSource,
  ExcaliburHook,
  HookHandler,
} from '@excalibur/extension-runtime';
