import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  excaliburEventSchema,
  type ExcaliburConfig,
  type ExcaliburEvent,
} from '@excalibur/shared';
import { ProviderError } from '@excalibur/shared';
import type { ChatInput, ChatOutput, ToolCall } from '@excalibur/model-gateway';
import type { AgentRunInput } from '../../types';
import { NATIVE_TOOL_NAMES } from '../../tools/native-tools';
import { MAX_ITERATIONS, NativeAgentAdapter } from './native-agent-adapter';

/**
 * Offline tests for the REAL native agentic loop (OSS-7). The model gateway is
 * an INJECTED FAKE that returns a scripted sequence of `ChatOutput`s (tool
 * calls then a final text turn) — no network, no keys. Tools run against a real
 * temp git repository so file/command/git effects are observed for real.
 */

let tmpRepo: string;

beforeEach(() => {
  tmpRepo = mkdtempSync(join(tmpdir(), 'excalibur-agent-loop-'));
  execFileSync('git', ['init', '-q'], { cwd: tmpRepo });
  execFileSync('git', ['config', 'user.email', 'test@excalibur.local'], { cwd: tmpRepo });
  execFileSync('git', ['config', 'user.name', 'Excalibur Test'], { cwd: tmpRepo });
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

/** A gateway that ALWAYS asks for a tool — used to prove the loop is bounded. */
class AlwaysToolGateway {
  calls = 0;
  chat(): Promise<ChatOutput> {
    this.calls += 1;
    return Promise.resolve({
      content: '',
      model: 'fake-model',
      usage: { inputTokens: 1, outputTokens: 1 },
      costCents: 0,
      finishReason: 'tool_calls',
      toolCalls: [toolCall(`c${this.calls}`, 'list_files', { path: '.' })],
    });
  }
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: args };
}

function makeInput(gateway: unknown, overrides?: Partial<AgentRunInput>): AgentRunInput {
  return {
    runId: 'run_20260614_120000',
    sessionId: 'sess_1',
    workdir: tmpRepo,
    prompt: 'Do the task.',
    role: 'implementer',
    config: permissiveConfig(),
    gateway: gateway as AgentRunInput['gateway'],
    phase: { id: 'implement', name: 'Implement', type: 'agent_work' },
    ...overrides,
  };
}

/** A config that allows mutating tools/commands so the loop runs unattended. */
function permissiveConfig(): ExcaliburConfig {
  return {
    ...DEFAULT_CONFIG,
    permissions: {
      ...DEFAULT_CONFIG.permissions,
      tools: {
        ...DEFAULT_CONFIG.permissions?.tools,
        write_file: true,
        run_command: true,
        apply_patch: true,
        create_branch: true,
        run_tests: true,
      },
      allowedCommands: ['*'],
    },
  };
}

async function collect(iterable: AsyncIterable<ExcaliburEvent>): Promise<ExcaliburEvent[]> {
  const events: ExcaliburEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe('NativeAgentAdapter identity', () => {
  it('is always detected and exposes the nine tools as capabilities', async () => {
    const adapter = new NativeAgentAdapter();
    expect(adapter.id).toBe('native');
    expect(adapter.name.length).toBeGreaterThan(0);
    expect(adapter.capabilities).toEqual([...NATIVE_TOOL_NAMES]);
    await expect(adapter.detect()).resolves.toBe(true);
  });
});

describe('NativeAgentAdapter — real tool loop', () => {
  it('runs write_file → run_command → final, really mutating the repo', async () => {
    const gateway = new FakeGateway([
      { toolCalls: [toolCall('c1', 'write_file', { path: 'src/added.ts', content: 'export const x = 1;\n' })] },
      { toolCalls: [toolCall('c2', 'run_command', { command: 'echo built' })] },
      { content: 'Done: added src/added.ts and ran the build.' },
    ]);

    const events = await collect(new NativeAgentAdapter().run(makeInput(gateway)));

    // The file was REALLY created in the temp repo.
    expect(existsSync(join(tmpRepo, 'src/added.ts'))).toBe(true);
    expect(readFileSync(join(tmpRepo, 'src/added.ts'), 'utf8')).toBe('export const x = 1;\n');

    // Three gateway turns (two tool turns + the final), bounded.
    expect(gateway.received.length).toBe(3);

    const types = events.map((event) => event.type);
    // Loop order: model_call → tool_call → file_write → model_call → tool_call
    // → command_completed → model_call → assistant_message → patch_generated.
    expect(types[0]).toBe('model_call');
    expect(types).toContain('tool_call');
    expect(types).toContain('file_write');
    expect(types).toContain('command_completed');
    expect(types).toContain('assistant_message');
    expect(types).toContain('patch_generated');

    // Every event validates against the canonical schema.
    for (const event of events) {
      const parsed = excaliburEventSchema.safeParse(event);
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    }

    // The command really ran (exit 0).
    const command = events.find((e) => e.type === 'command_completed');
    expect(command?.payload['exitCode']).toBe(0);
    expect(String(command?.payload['result'])).toContain('built');

    // The final assistant_message carried the model's summary.
    const final = events.filter((e) => e.type === 'assistant_message').at(-1);
    expect(String(final?.payload['content'])).toContain('Done');

    // The tools were offered to the model on the first turn.
    expect(gateway.received[0]?.tools?.map((t) => t.name)).toEqual([...NATIVE_TOOL_NAMES]);
  });

  it('feeds tool results back as role:tool messages on the next turn', async () => {
    const gateway = new FakeGateway([
      { toolCalls: [toolCall('c1', 'write_file', { path: 'a.txt', content: 'hi' })] },
      { content: 'done' },
    ]);
    await collect(new NativeAgentAdapter().run(makeInput(gateway)));

    const secondTurn = gateway.received[1];
    expect(secondTurn).toBeDefined();
    const toolMsg = secondTurn?.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.toolCallId).toBe('c1');
    expect(String(toolMsg?.content)).toContain('wrote');
    // The assistant turn that requested the tool is preserved with its toolCalls.
    const assistantMsg = secondTurn?.messages.find(
      (m) => m.role === 'assistant' && m.toolCalls !== undefined,
    );
    expect(assistantMsg?.toolCalls?.[0]?.name).toBe('write_file');
  });
});

describe('NativeAgentAdapter — permission denial', () => {
  it('denies a write to a blocked path, does not write, continues the loop', async () => {
    const gateway = new FakeGateway([
      { toolCalls: [toolCall('c1', 'write_file', { path: '.env', content: 'SECRET=1' })] },
      { content: 'understood, I will not write .env' },
    ]);
    const events = await collect(new NativeAgentAdapter().run(makeInput(gateway)));

    // The blocked file was NOT created.
    expect(existsSync(join(tmpRepo, '.env'))).toBe(false);

    // The model received a permission-denied result and the loop continued.
    const fileWrite = events.find((e) => e.type === 'file_write');
    expect(fileWrite?.payload['ok']).toBe(false);
    expect(String(fileWrite?.payload['result'])).toContain('permission denied');

    const toolMsg = gateway.received[1]?.messages.find((m) => m.role === 'tool');
    expect(String(toolMsg?.content)).toContain('permission denied');

    // The loop reached the model's final answer.
    expect(events.some((e) => e.type === 'assistant_message')).toBe(true);
  });
});

describe('NativeAgentAdapter — confirmation gate', () => {
  function askConfig(): ExcaliburConfig {
    return {
      ...DEFAULT_CONFIG,
      permissions: {
        ...DEFAULT_CONFIG.permissions,
        tools: { ...DEFAULT_CONFIG.permissions?.tools, write_file: 'ask' },
      },
    };
  }

  it('does NOT execute a confirm-required tool when confirm returns false', async () => {
    const gateway = new FakeGateway([
      { toolCalls: [toolCall('c1', 'write_file', { path: 'src/x.ts', content: 'x' })] },
      { content: 'ok' },
    ]);
    const events = await collect(
      new NativeAgentAdapter().run(
        makeInput(gateway, {
          config: askConfig(),
          confirm: () => Promise.resolve(false),
        }),
      ),
    );
    expect(existsSync(join(tmpRepo, 'src/x.ts'))).toBe(false);
    const decision = events.find(
      (e) => e.type === 'policy_decision' && e.payload['kind'] === 'confirmation',
    );
    expect(decision?.payload['decision']).toBe('deny');
    const toolMsg = gateway.received[1]?.messages.find((m) => m.role === 'tool');
    expect(String(toolMsg?.content)).toContain('user declined');
  });

  it('executes a confirm-required tool when confirm returns true', async () => {
    const gateway = new FakeGateway([
      { toolCalls: [toolCall('c1', 'write_file', { path: 'src/x.ts', content: 'x' })] },
      { content: 'ok' },
    ]);
    await collect(
      new NativeAgentAdapter().run(
        makeInput(gateway, {
          config: askConfig(),
          confirm: () => Promise.resolve(true),
        }),
      ),
    );
    expect(existsSync(join(tmpRepo, 'src/x.ts'))).toBe(true);
  });

  it('declines a confirm-required tool when NO confirm callback is supplied', async () => {
    const gateway = new FakeGateway([
      { toolCalls: [toolCall('c1', 'write_file', { path: 'src/x.ts', content: 'x' })] },
      { content: 'ok' },
    ]);
    await collect(new NativeAgentAdapter().run(makeInput(gateway, { config: askConfig() })));
    // Safe default: a mutating tool needing confirmation never auto-executes.
    expect(existsSync(join(tmpRepo, 'src/x.ts'))).toBe(false);
  });
});

describe('NativeAgentAdapter — path traversal', () => {
  it('rejects a write outside the workdir without touching the fs', async () => {
    const escapePath = '../../etc/excalibur-pwned';
    const gateway = new FakeGateway([
      { toolCalls: [toolCall('c1', 'write_file', { path: escapePath, content: 'pwn' })] },
      { content: 'cannot escape' },
    ]);
    const events = await collect(new NativeAgentAdapter().run(makeInput(gateway)));

    expect(existsSync(join(tmpRepo, escapePath))).toBe(false);
    const fileWrite = events.find((e) => e.type === 'file_write');
    expect(fileWrite?.payload['ok']).toBe(false);
    expect(String(fileWrite?.payload['result'])).toContain('escapes the working directory');
  });

  it('rejects an absolute read path', async () => {
    const gateway = new FakeGateway([
      { toolCalls: [toolCall('c1', 'read_file', { path: '/etc/passwd' })] },
      { content: 'cannot read' },
    ]);
    const events = await collect(new NativeAgentAdapter().run(makeInput(gateway)));
    const read = events.find((e) => e.type === 'file_read');
    expect(read?.payload['ok']).toBe(false);
    expect(String(read?.payload['result'])).toContain('absolute paths are not allowed');
  });
});

describe('NativeAgentAdapter — redaction', () => {
  it('redacts a secret read off disk before it re-enters the prompt/events', async () => {
    const fakeKey = `sk-${'a'.repeat(40)}`;
    writeFileSync(join(tmpRepo, 'config.ts'), `export const key = '${fakeKey}';\n`);

    const gateway = new FakeGateway([
      { toolCalls: [toolCall('c1', 'read_file', { path: 'config.ts' })] },
      { content: 'read it' },
    ]);
    const events = await collect(new NativeAgentAdapter().run(makeInput(gateway)));

    const read = events.find((e) => e.type === 'file_read');
    expect(String(read?.payload['result'])).toContain('[REDACTED]');
    expect(String(read?.payload['result'])).not.toContain(fakeKey);

    // The tool message fed back to the model is redacted too.
    const toolMsg = gateway.received[1]?.messages.find((m) => m.role === 'tool');
    expect(String(toolMsg?.content)).not.toContain(fakeKey);
    expect(String(toolMsg?.content)).toContain('[REDACTED]');
  });
});

describe('NativeAgentAdapter — loop bound', () => {
  it('stops at MAX_ITERATIONS when the gateway always requests a tool', async () => {
    const gateway = new AlwaysToolGateway();
    const events = await collect(new NativeAgentAdapter().run(makeInput(gateway)));

    expect(gateway.calls).toBe(MAX_ITERATIONS);
    const limit = events.find(
      (e) => e.type === 'policy_decision' && String(e.payload['message']).includes('step limit'),
    );
    expect(limit).toBeDefined();
    // It terminated (did not hang) and emitted a final assistant_message.
    expect(events.some((e) => e.type === 'assistant_message')).toBe(true);
  });
});

describe('NativeAgentAdapter — abort', () => {
  it('stops the loop when the abort signal fires', async () => {
    const controller = new AbortController();
    const gateway = new FakeGateway([
      { toolCalls: [toolCall('c1', 'write_file', { path: 'a.txt', content: 'a' })] },
      { content: 'never reached' },
    ]);
    controller.abort();
    const events = await collect(
      new NativeAgentAdapter().run(makeInput(gateway, { signal: controller.signal })),
    );
    // Aborted before the first gateway call.
    expect(gateway.received.length).toBe(0);
    expect(
      events.some(
        (e) => e.type === 'policy_decision' && String(e.payload['message']).includes('aborted'),
      ),
    ).toBe(true);
  });
});

describe('NativeAgentAdapter — provider/tool-call error (graceful)', () => {
  /** A gateway whose chat() throws a malformed-args ProviderError. */
  class ThrowingGateway {
    calls = 0;
    chat(): Promise<ChatOutput> {
      this.calls += 1;
      return Promise.reject(
        new ProviderError('Model returned malformed JSON arguments for tool "write_file".', {
          code: 'invalid_request',
          details: { tool: 'write_file' },
        }),
      );
    }
  }

  it('ends the run WITHOUT throwing, emits a graceful error event + final completion', async () => {
    const gateway = new ThrowingGateway();
    const adapter = new NativeAgentAdapter();

    // The async generator must NOT throw — collect() would reject otherwise.
    const events = await collect(adapter.run(makeInput(gateway)));

    // Only one gateway call happened, then the loop broke cleanly.
    expect(gateway.calls).toBe(1);

    // A graceful `error` event (reused existing type) describes the failure.
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(String(errorEvent?.payload['message'])).toContain('invalid tool call');

    // The final completion turn is still produced.
    const final = events.filter((e) => e.type === 'assistant_message').at(-1);
    expect(final).toBeDefined();
    expect(final?.payload['errored']).toBe(true);
    expect(String(final?.payload['content'])).toContain('Run ended early');

    // Every emitted event still validates against the canonical schema.
    for (const event of events) {
      const parsed = excaliburEventSchema.safeParse(event);
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(
        true,
      );
    }
  });

  it('redacts a secret embedded in the thrown provider error message', async () => {
    const fakeKey = `sk-${'a'.repeat(40)}`;
    class LeakyGateway {
      chat(): Promise<ChatOutput> {
        return Promise.reject(new Error(`provider blew up with key ${fakeKey}`));
      }
    }
    const events = await collect(new NativeAgentAdapter().run(makeInput(new LeakyGateway())));
    const errorEvent = events.find((e) => e.type === 'error');
    expect(String(errorEvent?.payload['message'])).not.toContain(fakeKey);
    expect(String(errorEvent?.payload['message'])).toContain('[REDACTED]');
  });
});

describe('NativeAgentAdapter — abort finalContent', () => {
  it('sets a clear "Run aborted." finalContent distinct from the step-limit case', async () => {
    const controller = new AbortController();
    const gateway = new FakeGateway([{ content: 'never reached' }]);
    controller.abort();
    const events = await collect(
      new NativeAgentAdapter().run(makeInput(gateway, { signal: controller.signal })),
    );
    const final = events.filter((e) => e.type === 'assistant_message').at(-1);
    expect(final?.payload['aborted']).toBe(true);
    expect(String(final?.payload['content'])).toBe('Run aborted.');
    // Distinct from the iteration-limit "truncated" summary content.
    expect(String(final?.payload['content'])).not.toContain('step limit');
  });
});

describe('NativeAgentAdapter — role-based tool exposure', () => {
  it('exposes only read-only tools to a planner/reviewer role', async () => {
    const gateway = new FakeGateway([{ content: 'plan complete' }]);
    await collect(new NativeAgentAdapter().run(makeInput(gateway, { role: 'reviewer' })));
    const offered = gateway.received[0]?.tools?.map((t) => t.name) ?? [];
    expect(offered.sort()).toEqual([
      'git_diff',
      'list_files',
      'read_file',
      'search_code',
      'update_tasks',
    ]);
    expect(offered).not.toContain('write_file');
    expect(offered).not.toContain('run_command');
  });
});
