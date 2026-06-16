import type { ToolSpec } from '@excalibur/model-gateway';
import { McpClient, type JsonObject, type McpToolResult } from './mcp-client';

/**
 * Connects configured MCP servers and exposes their tools to the native agent
 * loop. Tool names are NAMESPACED as `mcp__<server>__<tool>` so they never
 * collide with the native tools and the dispatcher can recognize + route them.
 * A server that fails to start is SKIPPED with a warning — MCP is additive and
 * must never break the agent run.
 */

/** Where a namespaced MCP tool routes: the owning server + its real tool name. */
export interface McpToolEntry {
  serverName: string;
  toolName: string;
  client: McpClient;
}

/** The result of connecting the configured MCP servers. */
export interface ConnectedMcp {
  /** Namespaced tool specs to merge into the model's tool list. */
  specs: ToolSpec[];
  /** Namespaced tool name → routing entry. */
  byName: Map<string, McpToolEntry>;
  /** Connected clients (close them all when the run ends). */
  clients: McpClient[];
  /** Servers that failed to connect (surface to the user; never fatal). */
  warnings: string[];
}

/** A server to spawn (from config `mcp.servers.<name>`). */
export interface McpServerSpec {
  command: string;
  args?: ReadonlyArray<string>;
  cwd?: string;
  env?: Record<string, string>;
}

const SEPARATOR = '__';

/** The namespaced tool name exposed to the model: `mcp__<server>__<tool>`. */
export function mcpToolDisplayName(serverName: string, toolName: string): string {
  return `mcp${SEPARATOR}${serverName}${SEPARATOR}${toolName}`;
}

/** Flattens an MCP tool result's content blocks to text for the model's tool message. */
export function mcpResultToText(result: McpToolResult): string {
  const text = result.content
    .map((block) =>
      block.type === 'text' && typeof block.text === 'string' ? block.text : `[${block.type}]`,
    )
    .join('\n')
    .trim();
  const body = text.length > 0 ? text : '(no content)';
  return result.isError ? `MCP tool reported an error: ${body}` : body;
}

/**
 * Connects every configured server, lists its tools, and builds the namespaced
 * specs + routing map. Each connect/list is isolated: a failing server is
 * recorded in `warnings` and skipped, never throwing.
 */
export async function connectMcpServers(
  servers: Record<string, McpServerSpec>,
  options: { timeoutMs?: number } = {},
): Promise<ConnectedMcp> {
  const specs: ToolSpec[] = [];
  const byName = new Map<string, McpToolEntry>();
  const clients: McpClient[] = [];
  const warnings: string[] = [];

  for (const [serverName, cfg] of Object.entries(servers)) {
    try {
      const client = await McpClient.connect({
        command: cfg.command,
        ...(cfg.args !== undefined ? { args: cfg.args } : {}),
        ...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {}),
        // Inherit the parent env (so the server finds its own auth) + non-secret
        // config overrides on top.
        env: { ...process.env, ...(cfg.env ?? {}) },
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      clients.push(client);
      for (const tool of await client.listTools()) {
        const display = mcpToolDisplayName(serverName, tool.name);
        specs.push({
          name: display,
          description: tool.description ?? `MCP tool "${tool.name}" (server: ${serverName})`,
          parameters: tool.inputSchema,
        });
        byName.set(display, { serverName, toolName: tool.name, client });
      }
    } catch (error) {
      warnings.push(
        `MCP server "${serverName}" unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { specs, byName, clients, warnings };
}

/** Closes every connected MCP client (best-effort; safe to call once at run end). */
export function closeMcp(connected: ConnectedMcp): void {
  for (const client of connected.clients) {
    try {
      client.close();
    } catch {
      /* already closed / dead — nothing to do */
    }
  }
}

/** Casts model-supplied tool arguments to the MCP JSON object shape. */
export function asJsonObject(args: Record<string, unknown>): JsonObject {
  return args as JsonObject;
}
