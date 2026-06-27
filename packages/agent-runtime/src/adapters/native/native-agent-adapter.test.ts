import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  DEFAULT_LSP_CONFIG,
  excaliburEventSchema,
  type ExcaliburConfig,
  type ExcaliburEvent,
} from '@excalibur/shared';
import { ProviderError } from '@excalibur/shared';
import type { ChatInput, ChatMessage, ChatOutput, ToolCall } from '@excalibur/model-gateway';
import type { AgentRunInput } from '../../types';
import { NATIVE_TOOL_NAMES } from '../../tools/native-tools';
import { MAX_ITERATIONS, NativeAgentAdapter } from './native-agent-adapter';
import { FAKE_LSP_SERVER } from '../../lsp/__fixtures__/fake-lsp-server';

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

/** A gateway that also STREAMS: `streamChat` emits the turn prose word by word
 *  through `onContent`, then returns the same complete output as `chat`. */
class FakeStreamingGateway extends FakeGateway {
  async streamChat(input: ChatInput, onContent: (delta: string) => void): Promise<ChatOutput> {
    const output = await this.chat(input); // consumes one scripted output
    for (const piece of output.content.split(/(\s+)/).filter((w) => w.length > 0)) {
      onContent(piece);
    }
    return output;
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
  it('is always detected and exposes its native tools as capabilities', async () => {
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
      {
        toolCalls: [
          toolCall('c1', 'write_file', { path: 'src/added.ts', content: 'export const x = 1;\n' }),
        ],
      },
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
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(
        true,
      );
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

    // A blocked path is a HARD DENY at the gate: an explicit, replayable
    // policy_decision deny is emitted and the executor is never invoked (so no
    // file_write event is produced for the denied call).
    const deny = events.find(
      (e) => e.type === 'policy_decision' && e.payload['decision'] === 'deny',
    );
    expect(deny).toBeDefined();
    expect(String(deny?.payload['message'])).toContain('blocked');
    expect(events.some((e) => e.type === 'file_write')).toBe(false);

    // The model received the denial as the tool result and the loop continued.
    const toolMsg = gateway.received[1]?.messages.find((m) => m.role === 'tool');
    expect(String(toolMsg?.content)).toContain('denied');
    expect(String(toolMsg?.content)).toContain('blocked');

    // The loop reached the model's final answer.
    expect(events.some((e) => e.type === 'assistant_message')).toBe(true);
  });
});

describe('NativeAgentAdapter — confirmation gate', () => {
  function askConfig(): ExcaliburConfig {
    return {
      ...DEFAULT_CONFIG,
      // These tests assert the confirmation gate, not LSP. Disable LSP so a
      // `.ts` write never spawns a real language server (a slow, env-dependent
      // side effect that flakes under parallel load).
      lsp: { ...DEFAULT_LSP_CONFIG, enabled: false },
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
  it('a write outside the workdir needs confirmation (declined without a confirmer)', async () => {
    const escapePath = '../../etc/excalibur-pwned';
    const gateway = new FakeGateway([
      { toolCalls: [toolCall('c1', 'write_file', { path: escapePath, content: 'pwn' })] },
      { content: 'cannot escape' },
    ]);
    const events = await collect(new NativeAgentAdapter().run(makeInput(gateway)));

    // No confirmer → the out-of-tree write is declined → nothing is written.
    expect(existsSync(join(tmpRepo, escapePath))).toBe(false);
    const decision = events.find(
      (e) => e.type === 'policy_decision' && e.payload['kind'] === 'confirmation',
    );
    expect(decision?.payload['decision']).toBe('deny');
    expect(String(decision?.payload['message'])).toMatch(/outside the working directory|declined/i);
  });

  it('writes outside the workdir when the user confirms', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'excalibur-sibling-'));
    try {
      const target = join(outside, 'created.txt');
      const gateway = new FakeGateway([
        { toolCalls: [toolCall('c1', 'write_file', { path: target, content: 'hello outside' })] },
        { content: 'done' },
      ]);
      await collect(
        new NativeAgentAdapter().run(makeInput(gateway, { confirm: () => Promise.resolve(true) })),
      );
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, 'utf8')).toContain('hello outside');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('allows reading a file OUTSIDE the working directory (absolute path)', async () => {
    // Reads are no longer confined to the working dir — the agent must be able
    // to review a sibling project / a file the user names. Writes stay confined.
    const outside = mkdtempSync(join(tmpdir(), 'excalibur-ext-'));
    writeFileSync(join(outside, 'doc.txt'), 'external content');
    try {
      const gateway = new FakeGateway([
        { toolCalls: [toolCall('c1', 'read_file', { path: join(outside, 'doc.txt') })] },
        { content: 'read it' },
      ]);
      const events = await collect(new NativeAgentAdapter().run(makeInput(gateway)));
      const read = events.find((e) => e.type === 'file_read');
      expect(read?.payload['ok']).toBe(true);
      expect(String(read?.payload['result'])).toContain('external content');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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

describe('NativeAgentAdapter — LSP per-edit diagnostics', () => {
  /**
   * permissiveConfig + an LSP server pointed at the fake language server.
   * Timeouts are generous: each test spawns a FRESH node subprocess and, under
   * vitest's parallel pool, cold-start + the initialize round-trip can spike on
   * a loaded machine (a real persistent language server is faster to reach).
   */
  function lspConfig(): ExcaliburConfig {
    return {
      ...permissiveConfig(),
      lsp: {
        enabled: true,
        diagnosticsTimeoutMs: 5000,
        diagnosticsSettleMs: 400,
        serverStartTimeoutMs: 20000,
        autoInstall: false,
        autoInstallTimeoutMs: 180000,
        servers: { typescript: { command: process.execPath, args: ['-e', FAKE_LSP_SERVER] } },
      },
    };
  }
  const LSP_TEST_TIMEOUT_MS = 30000;

  it(
    'emits a diagnostics event AND appends the errors to the edit tool result',
    async () => {
      const gateway = new FakeGateway([
        {
          toolCalls: [
            toolCall('c1', 'write_file', {
              path: 'bad.ts',
              content: '__ERR__ const x: number = "s";\n',
            }),
          ],
        },
        { content: 'I will fix the type error.' },
      ]);
      const events = await collect(
        new NativeAgentAdapter().run(makeInput(gateway, { config: lspConfig() })),
      );

      // A typed diagnostics event was emitted for the edited file.
      const diag = events.find((e) => e.type === 'diagnostics');
      expect(diag).toBeDefined();
      expect(diag?.payload['file']).toBe('bad.ts');
      expect(diag?.payload['errorCount']).toBe(1);

      // The SAME errors were appended to the write_file tool result fed to the
      // model on the next turn (the self-correction substrate).
      const toolMsg = gateway.received[1]?.messages.find(
        (m) => m.role === 'tool' && m.toolCallId === 'c1',
      );
      expect(String(toolMsg?.content)).toContain('Compiler diagnostics (LSP)');
      expect(String(toolMsg?.content)).toContain('bad.ts:1:7');
      expect(String(toolMsg?.content)).toContain('Type error');
    },
    LSP_TEST_TIMEOUT_MS,
  );

  it(
    'emits a clean diagnostics event and appends NOTHING when the edit has no errors',
    async () => {
      const gateway = new FakeGateway([
        {
          toolCalls: [
            toolCall('c1', 'write_file', { path: 'ok.ts', content: 'export const ok = 1;\n' }),
          ],
        },
        { content: 'done' },
      ]);
      const events = await collect(
        new NativeAgentAdapter().run(makeInput(gateway, { config: lspConfig() })),
      );

      const diag = events.find((e) => e.type === 'diagnostics');
      expect(diag?.payload['errorCount']).toBe(0);
      const toolMsg = gateway.received[1]?.messages.find(
        (m) => m.role === 'tool' && m.toolCallId === 'c1',
      );
      expect(String(toolMsg?.content)).toContain('wrote'); // the normal result
      expect(String(toolMsg?.content)).not.toContain('Compiler diagnostics');
    },
    LSP_TEST_TIMEOUT_MS,
  );

  it('stays inert (no diagnostics event) when LSP is disabled', async () => {
    const gateway = new FakeGateway([
      { toolCalls: [toolCall('c1', 'write_file', { path: 'bad.ts', content: '__ERR__ x\n' })] },
      { content: 'done' },
    ]);
    const disabled: ExcaliburConfig = {
      ...lspConfig(),
      lsp: { ...lspConfig().lsp!, enabled: false },
    };
    const events = await collect(
      new NativeAgentAdapter().run(makeInput(gateway, { config: disabled })),
    );
    expect(events.some((e) => e.type === 'diagnostics')).toBe(false);
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
      'lsp',
      'question',
      'read_file',
      'research',
      'search_code',
      'skill',
      'update_tasks',
      'web_crawl',
      'web_extract',
      'web_fetch',
      'web_search',
    ]);
    expect(offered).not.toContain('write_file');
    expect(offered).not.toContain('run_command');
  });

  it('runs the reviewer role as an ADVERSARIAL reviewer (refute, not rubber-stamp)', async () => {
    const gateway = new FakeGateway([{ content: 'no issues found' }]);
    await collect(new NativeAgentAdapter().run(makeInput(gateway, { role: 'reviewer' })));
    const system = String(gateway.received[0]?.messages?.[0]?.content ?? '');
    expect(system).toContain('ADVERSARIAL reviewer');
    expect(system).toContain('REFUTE');
  });

  it('gives the security role a security-lens adversarial preamble', async () => {
    const gateway = new FakeGateway([{ content: 'ok' }]);
    await collect(new NativeAgentAdapter().run(makeInput(gateway, { role: 'security' })));
    const system = String(gateway.received[0]?.messages?.[0]?.content ?? '');
    expect(system).toContain('ADVERSARIAL reviewer');
    expect(system.toLowerCase()).toContain('security');
  });

  it('does NOT add the adversarial preamble to an implementer role', async () => {
    const gateway = new FakeGateway([{ content: 'done' }]);
    await collect(new NativeAgentAdapter().run(makeInput(gateway))); // implementer (default)
    const system = String(gateway.received[0]?.messages?.[0]?.content ?? '');
    expect(system).not.toContain('ADVERSARIAL reviewer');
  });

  it('gives a writing role the default engineering-quality bar (structure + verify-it-runs)', async () => {
    const gateway = new FakeGateway([{ content: 'done' }]);
    await collect(new NativeAgentAdapter().run(makeInput(gateway))); // implementer (default)
    const system = String(gateway.received[0]?.messages?.[0]?.content ?? '');
    expect(system).toContain('production-quality bar');
    expect(system).toContain('separated into their own modules'); // separation of concerns
    expect(system).toContain('Before declaring done, VERIFY'); // verify-it-runs, first
    // The guidance is general, not ad-hoc — and composes with (does not replace) narration.
    expect(system).toContain('Narrate your work');
  });

  it('does NOT add the engineering bar to a read-only role (it observes, it does not build)', async () => {
    const gateway = new FakeGateway([{ content: 'ok' }]);
    await collect(new NativeAgentAdapter().run(makeInput(gateway, { role: 'reviewer' })));
    const system = String(gateway.received[0]?.messages?.[0]?.content ?? '');
    expect(system).not.toContain('production-quality bar');
    expect(system).not.toContain('Before declaring done, VERIFY');
  });

  it('keeps the engineering bar for a custom-persona writing agent (persona + protocol)', async () => {
    const gateway = new FakeGateway([{ content: 'done' }]);
    await collect(
      new NativeAgentAdapter().run(
        makeInput(gateway, { systemPrompt: 'You are Merlin, a wise refactoring sage.' }),
      ),
    );
    const system = String(gateway.received[0]?.messages?.[0]?.content ?? '');
    expect(system).toContain('You are Merlin, a wise refactoring sage.');
    expect(system).toContain('production-quality bar'); // appended body still applies
  });
});

describe('NativeAgentAdapter — custom agent overrides (P1.7)', () => {
  it('uses the custom systemPrompt as the persona header but keeps the tool protocol', async () => {
    const gateway = new FakeGateway([{ content: 'done' }]);
    await collect(
      new NativeAgentAdapter().run(
        makeInput(gateway, { systemPrompt: 'You are Merlin, a wise refactoring sage.' }),
      ),
    );
    const system = String(gateway.received[0]?.messages?.[0]?.content ?? '');
    // Persona replaces the default "You are the Excalibur native agent acting as…".
    expect(system).toContain('You are Merlin, a wise refactoring sage.');
    expect(system).not.toContain('acting as the "implementer" role');
    // The operational protocol still applies (the tool-use contract is preserved).
    expect(system).toContain('update_tasks');
  });

  it('forwards the agent temperature to the gateway', async () => {
    const gateway = new FakeGateway([{ content: 'done' }]);
    await collect(new NativeAgentAdapter().run(makeInput(gateway, { temperature: 0.15 })));
    expect(gateway.received[0]?.temperature).toBe(0.15);
  });

  it('narrows the advertised tools to the allowlist (intersected with the role floor)', async () => {
    const gateway = new FakeGateway([{ content: 'done' }]);
    await collect(
      new NativeAgentAdapter().run(
        makeInput(gateway, { allowedTools: ['read_file', 'search_code'] }),
      ),
    );
    const names = gateway.received[0]?.tools?.map((t) => t.name) ?? [];
    expect(names.sort()).toEqual(['read_file', 'search_code']);
  });

  it('cannot widen a read-only role beyond its floor via allowedTools (deny wins)', async () => {
    const gateway = new FakeGateway([{ content: 'done' }]);
    await collect(
      new NativeAgentAdapter().run(
        // A planner (read-only) asking for write_file gets nothing extra.
        makeInput(gateway, { role: 'planner', allowedTools: ['read_file', 'write_file'] }),
      ),
    );
    const names = gateway.received[0]?.tools?.map((t) => t.name) ?? [];
    expect(names).toContain('read_file');
    expect(names).not.toContain('write_file');
  });

  it('merges agent permission overrides so the agent can tighten (deny a tool)', async () => {
    // The project config allows run_command; the agent denies it → denied.
    const gateway = new FakeGateway([
      { toolCalls: [toolCall('c1', 'run_command', { command: 'echo hi' })] },
      { content: 'done' },
    ]);
    const events = await collect(
      new NativeAgentAdapter().run(
        makeInput(gateway, { permissions: { tools: { run_command: false } } }),
      ),
    );
    const toolMsg = gateway.received[1]?.messages.find((m) => m.role === 'tool');
    expect(String(toolMsg?.content ?? '')).toMatch(/denied|disabled|not permitted/i);
    // No command actually completed.
    expect(events.find((e) => e.type === 'command_completed')).toBeUndefined();
  });
});

describe('NativeAgentAdapter — skill progressive disclosure (P1.8b)', () => {
  it('lists discovered SKILL.md skills in the system prompt (so the model can pull them)', async () => {
    // A skill in the workdir under skills/<name>/SKILL.md.
    const skillDir = join(tmpRepo, 'skills', 'deploy');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: deploy\ndescription: How to ship the project\n---\nRun make ship.',
      'utf8',
    );
    const gateway = new FakeGateway([{ content: 'noted' }]);
    await collect(new NativeAgentAdapter().run(makeInput(gateway)));
    const system = String(gateway.received[0]?.messages?.[0]?.content ?? '');
    expect(system).toMatch(/Available skills/i);
    expect(system).toContain('deploy: How to ship the project');
    // And the `skill` tool is advertised so the model can load it.
    expect(gateway.received[0]?.tools?.map((t) => t.name)).toContain('skill');
  });

  it('omits the skills hint when the project has no skills', async () => {
    const gateway = new FakeGateway([{ content: 'noted' }]);
    await collect(new NativeAgentAdapter().run(makeInput(gateway)));
    const system = String(gateway.received[0]?.messages?.[0]?.content ?? '');
    expect(system).not.toMatch(/Available skills/i);
  });
});

describe('NativeAgentAdapter — in-turn compaction hook', () => {
  it('compacts the running messages mid-turn, emits the event, and continues with the compacted array', async () => {
    // Turn 1 calls a tool; turn 2 finishes. The injected compactor truncates the
    // tool result the second time it is called (once a tool result exists) — the
    // Tier-1 shape — so the loop carries a SHORTER, still provider-valid array.
    const gateway = new FakeGateway([
      { toolCalls: [toolCall('c1', 'write_file', { path: 'a.txt', content: 'hello world' })] },
      { content: 'done' },
    ]);
    const seenRoles: string[][] = [];
    const compactContext = (messages: ChatMessage[]): Promise<ChatMessage[] | null> => {
      seenRoles.push(messages.map((m) => m.role));
      const hasToolResult = messages.some((m) => m.role === 'tool');
      if (!hasToolResult) {
        return Promise.resolve(null); // under budget on the first turn
      }
      // A provider-VALID, shorter copy: truncate the tool output, keep ids/structure.
      return Promise.resolve(
        messages.map((m) => (m.role === 'tool' ? { ...m, content: 'SHRUNK' } : m)),
      );
    };

    const events = await collect(
      new NativeAgentAdapter().run(makeInput(gateway, { compactContext })),
    );

    // Called once per iteration, before each model call.
    expect(seenRoles.length).toBe(2);
    expect(seenRoles[0]).not.toContain('tool'); // first turn: no tool result yet

    // A `compaction` event fired with the in-turn scope and a real reduction.
    const compaction = events.find((e) => e.type === 'compaction');
    expect(compaction).toBeDefined();
    expect(compaction?.payload['scope']).toBe('in-turn');
    expect(Number(compaction?.payload['after'])).toBeLessThan(
      Number(compaction?.payload['before']),
    );
    // The event still validates against the canonical schema.
    expect(excaliburEventSchema.safeParse(compaction).success).toBe(true);

    // The SECOND model turn received the compacted messages (tool result shrunk),
    // proving the loop swapped in the compactor's array and kept going.
    const secondTurn = gateway.received[1];
    const toolMsg = secondTurn?.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('SHRUNK');
    expect(toolMsg?.toolCallId).toBe('c1'); // pairing id preserved

    // The run still completed normally.
    expect(
      String(events.filter((e) => e.type === 'assistant_message').at(-1)?.payload['content']),
    ).toContain('done');
  });

  it('does nothing when the compactor returns null (no event, unchanged messages)', async () => {
    const gateway = new FakeGateway([
      { toolCalls: [toolCall('c1', 'write_file', { path: 'a.txt', content: 'x' })] },
      { content: 'done' },
    ]);
    const compactContext = (): Promise<ChatMessage[] | null> => Promise.resolve(null);

    const events = await collect(
      new NativeAgentAdapter().run(makeInput(gateway, { compactContext })),
    );

    expect(events.some((e) => e.type === 'compaction')).toBe(false);
    // Untouched: the second turn still carries the real tool result.
    const toolMsg = gateway.received[1]?.messages.find((m) => m.role === 'tool');
    expect(String(toolMsg?.content)).toContain('wrote');
  });

  it('never breaks the loop when the compactor throws (best-effort)', async () => {
    const gateway = new FakeGateway([
      { toolCalls: [toolCall('c1', 'write_file', { path: 'a.txt', content: 'x' })] },
      { content: 'done' },
    ]);
    const compactContext = (): Promise<ChatMessage[] | null> => {
      throw new Error('compactor exploded');
    };

    const events = await collect(
      new NativeAgentAdapter().run(makeInput(gateway, { compactContext })),
    );

    // No compaction event, but the run completes unharmed.
    expect(events.some((e) => e.type === 'compaction')).toBe(false);
    expect(
      String(events.filter((e) => e.type === 'assistant_message').at(-1)?.payload['content']),
    ).toContain('done');
  });
});

describe('NativeAgentAdapter — live narration streaming', () => {
  it('streams each turn prose to onNarration (accumulating) when the gateway can streamChat', async () => {
    const gateway = new FakeStreamingGateway([
      {
        content: 'Let me read the file.',
        toolCalls: [toolCall('c1', 'write_file', { path: 'a.txt', content: 'hi' })],
      },
      { content: 'All done — file written.' },
    ]);
    const chunks: { delta: string; content: string }[] = [];
    const events = await collect(
      new NativeAgentAdapter().run(makeInput(gateway, { onNarration: (c) => chunks.push(c) })),
    );

    // The prose arrived in MULTIPLE fragments (typed out), accumulating per turn.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.content.startsWith('Let')).toBe(true);
    const turn1 = chunks.filter((c) => c.content.startsWith('Let')).at(-1);
    expect(turn1?.content).toBe('Let me read the file.');
    expect(chunks.at(-1)?.content).toBe('All done — file written.');
    // Streaming did not change the loop: the tool ran and the run completed.
    expect(events.some((e) => e.type === 'file_write')).toBe(true);
    expect(
      String(events.filter((e) => e.type === 'assistant_message').at(-1)?.payload['content']),
    ).toContain('All done');
  });

  it('does NOT stream (no onNarration calls) when the gateway lacks streamChat', async () => {
    const gateway = new FakeGateway([{ content: 'done' }]); // chat-only
    const chunks: unknown[] = [];
    await collect(
      new NativeAgentAdapter().run(makeInput(gateway, { onNarration: () => chunks.push(1) })),
    );
    expect(chunks).toHaveLength(0); // fell back to a plain non-streamed chat()
  });
});
