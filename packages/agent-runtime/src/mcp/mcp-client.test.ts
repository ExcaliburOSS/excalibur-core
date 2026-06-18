import { describe, expect, it } from 'vitest';
import { isExcaliburError } from '@excalibur/shared';
import { McpClient, MCP_PROTOCOL_VERSION } from './mcp-client';

/**
 * A tiny inline MCP server (run via `process.execPath -e`) that speaks
 * line-delimited JSON-RPC 2.0 over stdio: it answers `initialize`,
 * `tools/list`, and `tools/call`, and swallows the `notifications/initialized`
 * notification. Deterministic, no network — stands in for a real MCP server.
 */
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
    if (msg.method === "notifications/initialized") continue; // notification: no reply
    let result;
    if (msg.method === "initialize") {
      result = {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "9.9.9" },
      };
    } else if (msg.method === "tools/list") {
      result = {
        tools: [
          {
            name: "echo",
            description: "Echoes its message back.",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            },
          },
        ],
      };
    } else if (msg.method === "tools/call") {
      if (msg.params.name === "echo") {
        result = {
          content: [{ type: "text", text: "echo:" + msg.params.arguments.message }],
          isError: false,
        };
      } else if (msg.params.name === "boom") {
        result = { content: [{ type: "text", text: "tool blew up" }], isError: true };
      } else {
        const err = { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown tool" } };
        process.stdout.write(JSON.stringify(err) + "\\n");
        continue;
      }
    } else {
      const err = { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } };
      process.stdout.write(JSON.stringify(err) + "\\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  }
});
`;

/** A server that completes the handshake but never answers `tools/list` (to exercise timeouts). */
const SILENT_AFTER_INIT = `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line.length === 0) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { protocolVersion: msg.params.protocolVersion, capabilities: {} },
      }) + "\\n");
    }
    // Everything else is ignored — the client must time out.
  }
});
`;

function connectFake(serverSource = FAKE_MCP_SERVER, timeoutMs?: number): Promise<McpClient> {
  return McpClient.connect({
    command: process.execPath,
    args: ['-e', serverSource],
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

describe('McpClient handshake', () => {
  it('completes the initialize handshake and records server info', async () => {
    const client = await connectFake();
    try {
      const info = client.getServerInfo();
      expect(info.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
      expect(info.capabilities).toEqual({ tools: {} });
      expect(info.serverInfo).toEqual({ name: 'fake-mcp', version: '9.9.9' });
    } finally {
      client.close();
    }
  });

  it('throws a mapped ProviderError when the executable cannot start', async () => {
    await expect(
      McpClient.connect({ command: 'excalibur-not-a-real-mcp-server-7f3a', timeoutMs: 2000 }),
    ).rejects.toMatchObject({ code: 'mcp_process_error' });
  });

  it('rejects an empty command without spawning', async () => {
    await expect(McpClient.connect({ command: '   ' })).rejects.toMatchObject({
      code: 'mcp_invalid_command',
    });
  });
});

describe('McpClient.listTools', () => {
  it('returns the tool descriptors from tools/list', async () => {
    const client = await connectFake();
    try {
      const tools = await client.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        name: 'echo',
        description: 'Echoes its message back.',
      });
      expect(tools[0]?.inputSchema).toMatchObject({ type: 'object' });
    } finally {
      client.close();
    }
  });
});

describe('McpClient.callTool', () => {
  it('round-trips a tool call and returns its content', async () => {
    const client = await connectFake();
    try {
      const result = await client.callTool('echo', { message: 'hello mcp' });
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: 'text', text: 'echo:hello mcp' }]);
    } finally {
      client.close();
    }
  });

  it('surfaces a tool-level failure as isError without throwing', async () => {
    const client = await connectFake();
    try {
      const result = await client.callTool('boom');
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toBe('tool blew up');
    } finally {
      client.close();
    }
  });

  it('throws a mapped ProviderError on a JSON-RPC error response', async () => {
    const client = await connectFake();
    try {
      await expect(client.callTool('does-not-exist')).rejects.toMatchObject({
        code: 'mcp_rpc_error',
      });
    } finally {
      client.close();
    }
  });

  it('rejects an empty tool name', async () => {
    const client = await connectFake();
    try {
      await expect(client.callTool('  ')).rejects.toMatchObject({ code: 'mcp_invalid_tool' });
    } finally {
      client.close();
    }
  });
});

describe('McpClient robustness', () => {
  it('times out a request that never gets a response', async () => {
    // A 1s request timeout: still proves the timeout path fires, but is robust
    // to CI/parallel load (a sub-150ms budget assumed faster-than-safe
    // subprocess startup and flaked when other suites spawned children at once).
    const client = await connectFake(SILENT_AFTER_INIT, 1000);
    try {
      const error = await client.listTools().catch((e: unknown) => e);
      expect(isExcaliburError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('mcp_timeout');
    } finally {
      client.close();
    }
  });

  it('rejects calls made after close()', async () => {
    const client = await connectFake();
    client.close();
    await expect(client.listTools()).rejects.toMatchObject({ code: 'mcp_closed' });
  });

  it('close() is idempotent', async () => {
    const client = await connectFake();
    expect(() => {
      client.close();
      client.close();
    }).not.toThrow();
  });
});
