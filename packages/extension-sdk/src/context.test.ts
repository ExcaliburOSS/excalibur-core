import { describe, expect, it } from 'vitest';
import { ContributionRegistry, HookRegistry } from '@excalibur/extension-runtime';
import { MockWorkItemProvider } from '@excalibur/work-items';
import { MockProvider } from '@excalibur/model-gateway';
import type { AgentAdapter, AgentRunInput } from '@excalibur/agent-runtime';
import { WorkflowValidationError, createEvent, type ExcaliburEvent } from '@excalibur/shared';
import { ExtensionDefinitionError } from './errors';
import { createExtensionContext, type ExtensionContext } from './context';
import { defineExtension, registerExtension } from './define-extension';
import type { AgentTool, ToolContext, ToolResult } from './interfaces/tools';
import type { CommunicationProvider, PostMessageResult } from './interfaces/communication';
import type { ContextDocument, ContextSource } from './interfaces/context-source';
import type { PolicyEvaluator } from './interfaces/policy';
import type { ReportGenerator } from './interfaces/reports';
import type { Exporter } from './interfaces/exporters';

function createHost(): { contributions: ContributionRegistry; hooks: HookRegistry } {
  return { contributions: new ContributionRegistry(), hooks: new HookRegistry() };
}

function createEchoTool(executions: unknown[]): AgentTool {
  return {
    name: 'echo-tool',
    description: 'Echoes its input back to the agent.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
      executions.push(input);
      return { success: true, output: JSON.stringify(input) };
    },
  };
}

function createFakeAgentAdapter(): AgentAdapter {
  return {
    id: 'fake-agent',
    name: 'Fake Agent',
    capabilities: ['read_file'],
    detect: () => Promise.resolve(true),
    async *run(input: AgentRunInput): AsyncIterable<ExcaliburEvent> {
      yield createEvent({
        type: 'assistant_message',
        runId: input.runId,
        payload: { message: 'fake agent ran' },
      });
    },
  };
}

describe('defineExtension registration flow against a real ContributionRegistry', () => {
  it('registers a work item provider, a tool and a hook handler retrievable from the host registries', async () => {
    const host = createHost();
    const provider = new MockWorkItemProvider('linear');
    const executions: unknown[] = [];
    const tool = createEchoTool(executions);
    const hookEvents: unknown[] = [];

    const extension = defineExtension({
      id: 'acme-integration',
      name: 'Acme Integration',
      version: '1.0.0',
      register(ctx: ExtensionContext) {
        ctx.workItems.registerProvider(provider);
        ctx.tools.registerTool(tool);
        ctx.hooks.on('run.completed', (event: unknown) => {
          hookEvents.push(event);
        });
      },
    });

    await registerExtension(extension, { ...host, source: 'local' });

    const providerContribution = host.contributions.get('work_item_provider', 'linear');
    expect(providerContribution).toBeDefined();
    expect(providerContribution?.extensionId).toBe('acme-integration');
    expect(providerContribution?.source).toBe('local');
    expect(providerContribution?.value).toBe(provider);

    const registeredProvider = providerContribution?.value as MockWorkItemProvider;
    const item = await registeredProvider.getWorkItem({
      integrationId: 'int-1',
      externalIdOrKey: 'DEMO-1',
    });
    expect(item.key).toBe('DEMO-1');

    const toolContribution = host.contributions.get('tool', 'echo-tool');
    expect(toolContribution).toBeDefined();
    expect(toolContribution?.value).toBe(tool);

    await host.hooks.emit('run.completed', { runId: 'run_20260613_101500' });
    expect(hookEvents).toEqual([{ runId: 'run_20260613_101500' }]);
  });

  it('lists contributions of one extension across kinds', async () => {
    const host = createHost();
    const extension = defineExtension({
      id: 'multi',
      name: 'Multi',
      version: '0.1.0',
      register(ctx: ExtensionContext) {
        ctx.workItems.registerProvider(new MockWorkItemProvider('jira'));
        ctx.tools.registerTool(createEchoTool([]));
      },
    });

    await registerExtension(extension, host);

    const all = host.contributions.list();
    const mine = all.filter((c) => c.extensionId === 'multi');
    expect(mine.map((c) => c.kind).sort()).toEqual(['tool', 'work_item_provider']);
    expect(host.contributions.list('tool')).toHaveLength(1);
  });
});

describe('ExtensionContext registries', () => {
  it('registers methodologies and workflows as declarative definitions visible to catalog helpers', () => {
    const host = createHost();
    const ctx = createExtensionContext({ extensionId: 'pack', ...host, source: 'project' });

    ctx.methodologies.register({
      id: 'pair-review',
      name: 'Pair Review',
      description: 'Two reviewers on every change.',
    });
    ctx.workflows.register({
      id: 'safe-hotfix',
      name: 'Safe Hotfix',
      mode: 'fast',
      phases: [{ id: 'plan', name: 'Plan', type: 'assistant_interaction' }],
    });

    const methodology = host.contributions.get('methodology', 'pair-review');
    expect(methodology?.source).toBe('project');
    expect(methodology?.definition).toMatchObject({ id: 'pair-review', name: 'Pair Review' });

    const workflow = host.contributions.get('workflow', 'safe-hotfix');
    expect(workflow?.definition).toMatchObject({ id: 'safe-hotfix', mode: 'fast' });

    expect(host.contributions.workflows().map((w) => w.id)).toContain('safe-hotfix');
    expect(host.contributions.methodologies().map((m) => m.id)).toContain('pair-review');
  });

  it('rejects invalid declarative definitions with WorkflowValidationError', () => {
    const host = createHost();
    const ctx = createExtensionContext({ extensionId: 'pack', ...host });

    expect(() =>
      ctx.workflows.register({ id: 'broken', name: 'Broken', mode: 'fast', phases: [] }),
    ).toThrow(WorkflowValidationError);
    expect(() => ctx.methodologies.register({ id: 'no-description', name: 'X' } as never)).toThrow(
      WorkflowValidationError,
    );
  });

  it('registers a model provider adapter under its name', () => {
    const host = createHost();
    const ctx = createExtensionContext({ extensionId: 'models-ext', ...host });
    const provider = new MockProvider({ name: 'acme-mock' });

    ctx.models.registerProvider(provider);

    const contribution = host.contributions.get('model_provider', 'acme-mock');
    expect(contribution?.value).toBe(provider);
    expect(contribution?.kind).toBe('model_provider');
  });

  it('registers an agent adapter under its id and keeps it runnable', async () => {
    const host = createHost();
    const ctx = createExtensionContext({ extensionId: 'agents-ext', ...host });
    const adapter = createFakeAgentAdapter();

    ctx.agents.registerAdapter(adapter);

    const contribution = host.contributions.get('agent_adapter', 'fake-agent');
    expect(contribution?.value).toBe(adapter);
    await expect((contribution?.value as AgentAdapter).detect()).resolves.toBe(true);
  });

  it('registers communication providers, context sources, policy evaluators, report generators and exporters', async () => {
    const host = createHost();
    const ctx = createExtensionContext({ extensionId: 'kitchen-sink', ...host });

    const communication: CommunicationProvider = {
      type: 'fake-chat',
      postMessage: async (): Promise<PostMessageResult> => ({ externalMessageId: 'm1' }),
      postThreadReply: async (): Promise<PostMessageResult> => ({ externalMessageId: 'm2' }),
      getThreadReplies: async () => [],
      validateCredentials: async () => true,
    };
    const contextSource: ContextSource = {
      id: 'fake-wiki',
      name: 'Fake Wiki',
      search: async () => [],
      load: async (): Promise<ContextDocument> => ({
        id: 'doc-1',
        title: 'Doc',
        content: 'content',
      }),
    };
    const evaluator: PolicyEvaluator = {
      id: 'always-allow',
      evaluate: async () => ({ decision: 'allow' }),
    };
    const reportGenerator: ReportGenerator = {
      id: 'sprint-health',
      generate: async () => ({ title: 'Sprint Health', markdown: '# Sprint Health' }),
    };
    const exporter: Exporter = {
      id: 's3-archive',
      export: async () => ({ success: true, exportedCount: 0 }),
    };

    ctx.communication.registerProvider(communication);
    ctx.contextSources.registerSource(contextSource);
    ctx.policies.registerEvaluator(evaluator);
    ctx.reports.registerGenerator(reportGenerator);
    ctx.exporters.registerExporter(exporter);

    expect(host.contributions.get('communication_provider', 'fake-chat')?.value).toBe(
      communication,
    );
    expect(host.contributions.get('context_source', 'fake-wiki')?.value).toBe(contextSource);
    expect(host.contributions.get('policy_evaluator', 'always-allow')?.value).toBe(evaluator);
    // Report generators share the report_template namespace (no separate
    // programmatic kind in the contribution catalog); generators travel in
    // `value`, declarative templates in `definition`.
    const reportContribution = host.contributions.get('report_template', 'sprint-health');
    expect(reportContribution?.value).toBe(reportGenerator);
    expect(reportContribution?.definition).toBeUndefined();
    expect(host.contributions.get('exporter', 's3-archive')?.value).toBe(exporter);

    const decision = await evaluator.evaluate({ action: 'file_write', filePath: 'src/a.ts' });
    expect(decision.decision).toBe('allow');
  });

  it('rejects programmatic contributions with missing identity or methods', () => {
    const host = createHost();
    const ctx = createExtensionContext({ extensionId: 'bad', ...host });

    expect(() => ctx.tools.registerTool({ name: '', description: 'x' } as never)).toThrow(
      ExtensionDefinitionError,
    );
    expect(() =>
      ctx.tools.registerTool({ name: 'no-exec', description: 'x', inputSchema: {} } as never),
    ).toThrow(ExtensionDefinitionError);
    expect(() => ctx.workItems.registerProvider({ type: 'linear' } as never)).toThrow(
      ExtensionDefinitionError,
    );
    expect(() => ctx.models.registerProvider(null as never)).toThrow(ExtensionDefinitionError);
  });
});

describe('createExtensionContext', () => {
  it('defaults source to local, config to an empty object and logger to a silent no-op', () => {
    const host = createHost();
    const ctx = createExtensionContext({ extensionId: 'defaults', ...host });

    ctx.tools.registerTool(createEchoTool([]));
    expect(host.contributions.get('tool', 'echo-tool')?.source).toBe('local');
    expect(ctx.config).toEqual({});
    expect(() => {
      ctx.logger.info('hello');
      ctx.logger.warn('careful');
      ctx.logger.error('boom');
    }).not.toThrow();
  });

  it('passes through host logger and config', () => {
    const host = createHost();
    const lines: string[] = [];
    const ctx = createExtensionContext({
      extensionId: 'configured',
      ...host,
      logger: {
        info: (msg) => lines.push(`info:${msg}`),
        warn: (msg) => lines.push(`warn:${msg}`),
        error: (msg) => lines.push(`error:${msg}`),
      },
      config: { apiKeyEnv: 'ACME_API_KEY' },
    });

    ctx.logger.info('ready');
    expect(lines).toEqual(['info:ready']);
    expect(ctx.config).toEqual({ apiKeyEnv: 'ACME_API_KEY' });
  });

  it('rejects an empty extension id', () => {
    const host = createHost();
    expect(() => createExtensionContext({ extensionId: '  ', ...host })).toThrow(
      ExtensionDefinitionError,
    );
  });

  it('exposes the shared hook registry so extensions observe host emissions', async () => {
    const host = createHost();
    const seen: unknown[] = [];
    const ctx = createExtensionContext({ extensionId: 'observer', ...host });

    ctx.hooks.on('patch.created', (event: unknown) => {
      seen.push(event);
    });
    await host.hooks.emit('patch.created', { patchId: 'patch_20260613_101500' });

    expect(seen).toEqual([{ patchId: 'patch_20260613_101500' }]);
  });
});
