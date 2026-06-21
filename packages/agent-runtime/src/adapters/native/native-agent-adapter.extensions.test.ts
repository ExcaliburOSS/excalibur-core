import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type ExcaliburConfig, type ExcaliburEvent } from '@excalibur/shared';
import type { ChatInput, ChatOutput, ToolCall } from '@excalibur/model-gateway';
import type { AgentRunInput } from '../../types';
import type {
  ExtensionTool,
  ExtensionToolContext,
  ExtensionToolResult,
} from '../../tools/extension-tools';
import { NativeAgentAdapter } from './native-agent-adapter';

/**
 * The native loop must ADVERTISE extension-contributed tools to the model and
 * EXECUTE them inside the run (extensions-spec.md §5, P0.1) — gated by the
 * PermissionEngine and visible to read-only roles only when `readOnly` is set.
 * The gateway is an injected fake; tools run against a real temp git repo.
 */

let tmpRepo: string;

beforeEach(() => {
  tmpRepo = mkdtempSync(join(tmpdir(), 'excalibur-ext-tools-'));
  execFileSync('git', ['init', '-q'], { cwd: tmpRepo });
});

afterEach(() => {
  rmSync(tmpRepo, { recursive: true, force: true });
});

/** A gateway driven by a fixed queue of outputs (one per loop iteration). */
class FakeGateway {
  readonly received: ChatInput[] = [];
  private index = 0;
  constructor(private readonly outputs: Partial<ChatOutput>[]) {}

  chat(input: ChatInput): Promise<ChatOutput> {
    this.received.push(input);
    const scripted = this.outputs[Math.min(this.index, this.outputs.length - 1)] ?? {};
    this.index += 1;
    return Promise.resolve({
      content: scripted.content ?? '',
      model: scripted.model ?? 'fake-model',
      usage: scripted.usage ?? { inputTokens: 10, outputTokens: 5 },
      costCents: scripted.costCents ?? 0,
      finishReason: scripted.finishReason ?? (scripted.toolCalls ? 'tool_calls' : 'stop'),
      ...(scripted.toolCalls ? { toolCalls: scripted.toolCalls } : {}),
    });
  }
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: args };
}

function configAllowing(tool: string | null): ExcaliburConfig {
  return {
    ...DEFAULT_CONFIG,
    permissions: {
      ...DEFAULT_CONFIG.permissions,
      tools: {
        ...DEFAULT_CONFIG.permissions?.tools,
        ...(tool !== null ? { [tool]: true } : {}),
      },
    },
  };
}

function makeInput(
  gateway: unknown,
  tools: ExtensionTool[],
  overrides?: Partial<AgentRunInput>,
): AgentRunInput {
  return {
    runId: 'run_20260621_120000',
    sessionId: 'sess_ext',
    workdir: tmpRepo,
    prompt: 'Do the task.',
    role: 'implementer',
    config: configAllowing('db_query'),
    gateway: gateway as AgentRunInput['gateway'],
    phase: { id: 'implement', name: 'Implement', type: 'agent_work' },
    extensionTools: tools,
    ...overrides,
  };
}

async function collect(iterable: AsyncIterable<ExcaliburEvent>): Promise<ExcaliburEvent[]> {
  const events: ExcaliburEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

/** A spyable extension tool that records the input + context it received. */
function makeTool(
  overrides: Partial<ExtensionTool> & { result?: ExtensionToolResult; throws?: boolean } = {},
): {
  tool: ExtensionTool;
  calls: Array<{ input: unknown; context: ExtensionToolContext }>;
} {
  const calls: Array<{ input: unknown; context: ExtensionToolContext }> = [];
  const tool: ExtensionTool = {
    name: overrides.name ?? 'db_query',
    description: overrides.description ?? 'Query the project database',
    inputSchema: overrides.inputSchema ?? {
      type: 'object',
      properties: { sql: { type: 'string' } },
    },
    ...(overrides.readOnly !== undefined ? { readOnly: overrides.readOnly } : {}),
    execute: (input, context): Promise<ExtensionToolResult> => {
      calls.push({ input, context });
      if (overrides.throws === true) {
        throw new Error('boom from extension');
      }
      return Promise.resolve(
        overrides.result ?? { success: true, output: 'rows: 3', data: { count: 3 } },
      );
    },
  };
  return { tool, calls };
}

describe('native adapter — extension tools', () => {
  it('advertises an extension tool to the model and executes it', async () => {
    const { tool, calls } = makeTool();
    const gateway = new FakeGateway([
      { toolCalls: [toolCall('c1', 'db_query', { sql: 'select 1' })] },
      { content: 'Done.' },
    ]);
    const events = await collect(new NativeAgentAdapter().run(makeInput(gateway, [tool])));

    // The tool spec was offered to the model on the first turn.
    const offered = (gateway.received[0]?.tools ?? []).map((t) => t.name);
    expect(offered).toContain('db_query');

    // execute() ran with the model's args and a well-formed context.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({ sql: 'select 1' });
    expect(calls[0]?.context.workdir).toBe(tmpRepo);
    expect(calls[0]?.context.runId).toBe('run_20260621_120000');
    expect(calls[0]?.context.role).toBe('implementer');
    expect(typeof calls[0]?.context.logger.info).toBe('function');

    // The result rode back to the model as a tool message and a tool_call event.
    const second = gateway.received[1];
    const toolMsg = second?.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('rows: 3');
    const extEvents = events.filter(
      (e) => e.type === 'tool_call' && e.payload['extension'] === true,
    );
    expect(extEvents.length).toBeGreaterThan(0);
  });

  it('reports a result event and final answer when the extension tool throws', async () => {
    const { tool } = makeTool({ throws: true });
    const gateway = new FakeGateway([
      { toolCalls: [toolCall('c1', 'db_query', {})] },
      { content: 'Recovered.' },
    ]);
    const events = await collect(new NativeAgentAdapter().run(makeInput(gateway, [tool])));

    const toolMsg = gateway.received[1]?.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('threw');
    // The run still reached a clean final assistant turn.
    expect(events.some((e) => e.type === 'assistant_message')).toBe(true);
  });

  it('hides a mutating extension tool from a read-only role but shows a readOnly one', async () => {
    const mutating = makeTool({ name: 'db_write' }).tool;
    const reader = makeTool({ name: 'db_read', readOnly: true }).tool;
    const gateway = new FakeGateway([{ content: 'Nothing to do.' }]);
    await collect(
      new NativeAgentAdapter().run(makeInput(gateway, [mutating, reader], { role: 'reviewer' })),
    );
    const offered = (gateway.received[0]?.tools ?? []).map((t) => t.name);
    expect(offered).toContain('db_read');
    expect(offered).not.toContain('db_write');
  });

  it('declines an extension tool when its flag is "ask" and there is no confirmer', async () => {
    const { tool, calls } = makeTool({ name: 'db_query' });
    const gateway = new FakeGateway([
      { toolCalls: [toolCall('c1', 'db_query', {})] },
      { content: 'OK.' },
    ]);
    // configAllowing(null) leaves db_query unset → checkTool defaults to "ask".
    await collect(
      new NativeAgentAdapter().run(makeInput(gateway, [tool], { config: configAllowing(null) })),
    );
    expect(calls).toHaveLength(0);
    const toolMsg = gateway.received[1]?.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/declined/i);
  });

  it('hard-denies an extension tool disabled in permissions.tools', async () => {
    const { tool, calls } = makeTool({ name: 'db_query' });
    const config: ExcaliburConfig = {
      ...DEFAULT_CONFIG,
      permissions: {
        ...DEFAULT_CONFIG.permissions,
        tools: { ...DEFAULT_CONFIG.permissions?.tools, db_query: false },
      },
    };
    const gateway = new FakeGateway([
      { toolCalls: [toolCall('c1', 'db_query', {})] },
      { content: 'OK.' },
    ]);
    await collect(new NativeAgentAdapter().run(makeInput(gateway, [tool], { config })));
    expect(calls).toHaveLength(0);
    const toolMsg = gateway.received[1]?.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/denied/i);
  });

  it('does not let an extension tool shadow a native tool', async () => {
    // An extension that (mis)declares `read_file` must not be dispatched as the
    // extension tool — the native read_file wins.
    const { tool, calls } = makeTool({ name: 'read_file' });
    const gateway = new FakeGateway([
      { toolCalls: [toolCall('c1', 'read_file', { path: '.' })] },
      { content: 'Done.' },
    ]);
    await collect(new NativeAgentAdapter().run(makeInput(gateway, [tool])));
    // The extension's execute was never called (native read_file handled it).
    expect(calls).toHaveLength(0);
  });
});
