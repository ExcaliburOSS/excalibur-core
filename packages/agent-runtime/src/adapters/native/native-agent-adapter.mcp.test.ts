import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type ExcaliburConfig, type ExcaliburEvent } from '@excalibur/shared';
import type { ChatInput, ChatOutput, ModelGateway } from '@excalibur/model-gateway';
import { NativeAgentAdapter } from './native-agent-adapter';
import type { AgentRunInput } from '../../types';

/** A tiny inline MCP server (line-delimited JSON-RPC) with an `echo` tool. */
const FAKE_MCP_SERVER = `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line.length === 0) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "notifications/initialized") continue;
    let result;
    if (msg.method === "initialize") {
      result = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "9.9.9" } };
    } else if (msg.method === "tools/list") {
      result = { tools: [{ name: "echo", description: "Echoes its message back.", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } }] };
    } else if (msg.method === "tools/call") {
      result = { content: [{ type: "text", text: "echo:" + msg.params.arguments.message }], isError: false };
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  }
});
`;

/**
 * A working MCP echo server that records liveness in a marker file: it writes the
 * file on startup and DELETES it when its stdin closes (which `closeMcp` triggers
 * via `child.stdin.end()`). The marker disappearing proves the subprocess was
 * torn down. `MCP_MARKER` is supplied through the server's configured env.
 */
const MARKER_MCP_SERVER = `
const fs = require("fs");
const marker = process.env.MCP_MARKER;
if (marker) { try { fs.writeFileSync(marker, "alive"); } catch {} }
function cleanup() { try { if (marker) fs.unlinkSync(marker); } catch {} process.exit(0); }
process.stdin.on("end", cleanup);
process.on("SIGTERM", cleanup);
${FAKE_MCP_SERVER}
`;

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function output(content: string, extra: Partial<ChatOutput> = {}): ChatOutput {
  return {
    content,
    model: 'fake',
    usage: { inputTokens: 1, outputTokens: 1 },
    costCents: 0,
    finishReason: 'stop',
    ...extra,
  };
}

/** A fake gateway that replays scripted outputs and records every chat input. */
function scriptedGateway(outputs: ChatOutput[], captured: ChatInput[]): ModelGateway {
  let i = 0;
  return {
    chat: (input: ChatInput): Promise<ChatOutput> => {
      captured.push(input);
      const out = outputs[Math.min(i, outputs.length - 1)];
      i += 1;
      return Promise.resolve(out as ChatOutput);
    },
  } as unknown as ModelGateway;
}

const withMcp = (servers: ExcaliburConfig['mcp']): ExcaliburConfig =>
  ({ ...DEFAULT_CONFIG, mcp: servers }) as ExcaliburConfig;

const DEMO = { servers: { demo: { command: process.execPath, args: ['-e', FAKE_MCP_SERVER] } } };

function makeInput(overrides: Partial<AgentRunInput>): AgentRunInput {
  return {
    runId: 'run_mcp',
    sessionId: 'sess_mcp',
    workdir: process.cwd(),
    prompt: 'use the echo tool',
    role: 'implementer',
    config: withMcp(DEMO),
    gateway: {} as unknown as ModelGateway,
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

describe('NativeAgentAdapter — MCP tool wiring', () => {
  it('exposes a namespaced MCP tool and routes an APPROVED call to the server', async () => {
    const captured: ChatInput[] = [];
    const gateway = scriptedGateway(
      [
        output('', {
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'm1', name: 'mcp__demo__echo', arguments: { message: 'hi' } }],
        }),
        output('done'),
      ],
      captured,
    );
    const events = await collect(
      new NativeAgentAdapter().run(
        makeInput({ gateway, confirm: () => Promise.resolve(true) }),
      ),
    );

    // The MCP tool is offered to the model, namespaced.
    expect(captured[0]!.tools?.some((t) => t.name === 'mcp__demo__echo')).toBe(true);
    // The call is dispatched (a tool_call event names it).
    expect(
      events.some((e) => e.type === 'tool_call' && e.payload['tool'] === 'mcp__demo__echo'),
    ).toBe(true);
    // The server's result flows back to the model as a tool message.
    const toolMsg = captured[1]?.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('echo:hi');
    // The run completes.
    expect(events.some((e) => e.type === 'assistant_message' && e.payload['content'] === 'done')).toBe(
      true,
    );
  });

  it('DECLINES the MCP call when there is no confirmer (external tools need approval)', async () => {
    const captured: ChatInput[] = [];
    const gateway = scriptedGateway(
      [
        output('', {
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'm1', name: 'mcp__demo__echo', arguments: { message: 'hi' } }],
        }),
        output('ok'),
      ],
      captured,
    );
    const events = await collect(new NativeAgentAdapter().run(makeInput({ gateway }))); // no confirm
    const toolMsg = captured[1]?.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('declined');
    expect(toolMsg?.content).not.toContain('echo:hi');
    expect(events.some((e) => e.type === 'policy_decision' && e.payload['decision'] === 'deny')).toBe(
      true,
    );
  });

  it('does NOT expose MCP tools to a read-only role (planner)', async () => {
    const captured: ChatInput[] = [];
    const gateway = scriptedGateway([output('just an answer')], captured);
    await collect(new NativeAgentAdapter().run(makeInput({ gateway, role: 'planner' })));
    expect(captured[0]!.tools?.some((t) => t.name.startsWith('mcp__'))).toBe(false);
  });

  it('skips a broken server with a warning and still completes the run', async () => {
    const captured: ChatInput[] = [];
    const gateway = scriptedGateway([output('answer')], captured);
    const events = await collect(
      new NativeAgentAdapter().run(
        makeInput({
          gateway,
          config: withMcp({ servers: { broken: { command: 'excalibur-not-a-real-mcp-bin-7f3a' } } }),
        }),
      ),
    );
    expect(
      events.some(
        (e) => e.type === 'policy_decision' && String(e.payload['message']).includes('unavailable'),
      ),
    ).toBe(true);
    expect(captured[0]!.tools?.some((t) => t.name.startsWith('mcp__'))).toBe(false);
    expect(events.some((e) => e.type === 'assistant_message')).toBe(true);
  });

  it('tears down spawned MCP subprocesses when the generator is abandoned at the warnings yield', async () => {
    const marker = join(tmpdir(), `excalibur-mcp-marker-${process.pid}-${Date.now()}`);
    const captured: ChatInput[] = [];
    const gateway = scriptedGateway([output('done')], captured);
    // Broken server FIRST (emits a warning), working server SECOND (spawns a real
    // subprocess that writes the marker). Both connect before the warning yields.
    const run = new NativeAgentAdapter().run(
      makeInput({
        gateway,
        confirm: () => Promise.resolve(true),
        config: withMcp({
          servers: {
            broken: { command: 'excalibur-not-a-real-mcp-bin-7f3a' },
            worker: {
              command: process.execPath,
              args: ['-e', MARKER_MCP_SERVER],
              env: { MCP_MARKER: marker },
            },
          },
        }),
      }),
    );
    const iterator = run[Symbol.asyncIterator]();

    // The first yielded event is the broken-server warning — by now both servers
    // have been connected, so the worker subprocess is alive (marker present).
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(String((first.value as ExcaliburEvent).payload['message'])).toContain('unavailable');
    expect(existsSync(marker)).toBe(true);

    // Abandon the run right here (as a consumer break / cancel would). The
    // `finally { closeMcp() }` must still run and reclaim the worker subprocess.
    await iterator.return?.(undefined);

    await waitFor(() => !existsSync(marker));
    expect(existsSync(marker)).toBe(false);
  });
});
