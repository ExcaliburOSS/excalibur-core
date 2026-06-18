import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpClient } from './mcp-client';

/**
 * Remote MCP over Streamable HTTP (plan P1.11). A mocked `fetch` plays a server:
 * it parses the POSTed JSON-RPC body and returns the matching response, assigning
 * a session id on `initialize` that the client must echo on later requests.
 */

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: { method?: string; id?: unknown; params?: { arguments?: { message?: string } } };
}

function fakeServer(): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(init.body as string);
    calls.push({ url: String(url), headers, body });
    const respond = (result: unknown, extraHeaders: Record<string, string> = {}): Response =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json', ...extraHeaders },
      });
    switch (body.method) {
      case 'initialize':
        return respond(
          { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } },
          { 'mcp-session-id': 'sess-xyz' },
        );
      case 'tools/list':
        return respond({ tools: [{ name: 'echo', description: 'echoes input', inputSchema: { type: 'object' } }] });
      case 'tools/call':
        return respond({ content: [{ type: 'text', text: `echo: ${body.params?.arguments?.message ?? ''}` }], isError: false });
      default:
        // a notification (no id) → 202 Accepted, empty body
        return new Response('', { status: 202 });
    }
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}

describe('McpClient.connectHttp (Streamable HTTP remote transport)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('handshakes, lists + calls tools, and echoes the session id + auth header', async () => {
    const server = fakeServer();
    globalThis.fetch = server.fetch;

    const client = await McpClient.connectHttp({
      url: 'https://mcp.example.com/rpc',
      headers: { Authorization: 'Bearer tok-123' },
    });
    expect(client.getServerInfo().serverInfo?.name).toBe('fake');

    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);

    const result = await client.callTool('echo', { message: 'hi' });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toBe('echo: hi');

    client.close();

    // Auth header on every request.
    expect(server.calls.every((c) => c.headers['Authorization'] === 'Bearer tok-123')).toBe(true);
    // The session id assigned on initialize is echoed on the subsequent calls.
    const afterInit = server.calls.filter((c) => c.body.method !== 'initialize');
    expect(afterInit.length).toBeGreaterThan(0);
    expect(afterInit.every((c) => c.headers['mcp-session-id'] === 'sess-xyz')).toBe(true);
  });

  it('rejects a non-http url', async () => {
    await expect(McpClient.connectHttp({ url: 'ftp://nope' })).rejects.toThrow(/http/i);
  });

  it('surfaces an HTTP error as a failed request (does not hang)', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500, statusText: 'Server Error' })) as unknown as typeof fetch;
    await expect(
      McpClient.connectHttp({ url: 'https://mcp.example.com/rpc', timeoutMs: 2000 }),
    ).rejects.toThrow(/500|Server Error/);
  });
});
