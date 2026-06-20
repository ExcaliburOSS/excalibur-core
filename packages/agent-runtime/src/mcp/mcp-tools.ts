import type { ToolSpec } from '@excalibur/model-gateway';
import { McpClient, type JsonObject, type McpToolResult } from './mcp-client';
import { allowedForRole, toolAccessFor, type McpToolAccess } from './mcp-policy';
import { assertServerEgress, type McpServerEgress } from './mcp-egress';
import type { PermissionEngine } from '../permissions/permission-engine';

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
  /** Read-only vs mutating classification (F6) — gates exposure + confirmation. */
  access: McpToolAccess;
  /** The server's trust posture (F6): `trusted` skips the per-call confirm. */
  trust: 'trusted' | 'untrusted' | 'prompt';
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

/**
 * A server to connect (from config `mcp.servers.<name>`). Either LOCAL (a
 * `command` to spawn over stdio) or REMOTE (a Streamable-HTTP `url` with optional
 * auth `headers`, e.g. `{ Authorization: 'Bearer …' }`).
 */
export interface McpServerSpec {
  command?: string;
  args?: ReadonlyArray<string>;
  cwd?: string;
  env?: Record<string, string>;
  /** Remote MCP endpoint (Streamable HTTP). Set this OR `command`. */
  url?: string;
  /** Headers sent on every remote request (auth, etc.). */
  headers?: Record<string, string>;
  /** Trust posture (F6): `trusted` skips per-call confirm (output still scanned). */
  trust?: 'trusted' | 'untrusted' | 'prompt';
  readOnlyTools?: ReadonlyArray<string>;
  mutatingTools?: ReadonlyArray<string>;
  /** Expose this server's read-only tools to read-only/research roles (default true). */
  allowReadOnlyRoles?: boolean;
  /** Per-server network sandbox (remote servers). */
  egress?: McpServerEgress;
  /** Auth (F6): static bearer from an env var NAME (`bearerEnv`); `oauth` reserved. */
  auth?: { type?: 'none' | 'bearerEnv' | 'oauth'; bearerEnv?: string };
}

/** Context controlling which tools a connection exposes + how it authenticates (F6). */
export interface ConnectMcpOptions {
  timeoutMs?: number;
  /** The agent role is read-only/research → only non-mutating tools are exposed. */
  isReadOnlyRole?: boolean;
  /** Permission engine for the per-server egress/SSRF gate (remote servers). */
  engine?: PermissionEngine;
  /** Environment used to resolve `auth.bearerEnv` (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
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
  options: ConnectMcpOptions = {},
): Promise<ConnectedMcp> {
  const specs: ToolSpec[] = [];
  const byName = new Map<string, McpToolEntry>();
  const clients: McpClient[] = [];
  const warnings: string[] = [];
  const env = options.env ?? process.env;
  const isReadOnlyRole = options.isReadOnlyRole ?? false;

  for (const [serverName, cfg] of Object.entries(servers)) {
    const trust = cfg.trust ?? 'prompt';
    const allowReadOnlyRoles = cfg.allowReadOnlyRoles ?? true;
    try {
      // Resolve a static bearer token from the env var NAMED in config (BYOK).
      const authHeaders: Record<string, string> = { ...(cfg.headers ?? {}) };
      if (cfg.auth?.type === 'bearerEnv' && cfg.auth.bearerEnv !== undefined) {
        const token = env[cfg.auth.bearerEnv];
        if (token !== undefined && token.length > 0) {
          authHeaders['Authorization'] = `Bearer ${token}`;
        } else {
          warnings.push(
            `MCP server "${serverName}" auth.bearerEnv "${cfg.auth.bearerEnv}" is unset; connecting without it.`,
          );
        }
      }

      let client: McpClient;
      if (cfg.url !== undefined && cfg.url.length > 0) {
        // Per-server egress sandbox + SSRF floor for a REMOTE endpoint (F6).
        if (options.engine !== undefined) {
          const verdict = await assertServerEgress(cfg.url, options.engine, cfg.egress);
          if (!verdict.allowed) {
            warnings.push(`MCP server "${serverName}" egress denied: ${verdict.reason}`);
            continue;
          }
        }
        client = await McpClient.connectHttp({
          url: cfg.url,
          ...(Object.keys(authHeaders).length > 0 ? { headers: authHeaders } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
      } else {
        client = await McpClient.connect({
          command: cfg.command ?? '',
          ...(cfg.args !== undefined ? { args: cfg.args } : {}),
          ...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {}),
          // Inherit the parent env (so the server finds its own auth) +
          // non-secret config overrides on top.
          env: { ...process.env, ...(cfg.env ?? {}) },
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
      }
      clients.push(client);

      const classConfig = {
        ...(cfg.readOnlyTools !== undefined ? { readOnlyTools: cfg.readOnlyTools } : {}),
        ...(cfg.mutatingTools !== undefined ? { mutatingTools: cfg.mutatingTools } : {}),
      };
      let hidden = 0;
      for (const tool of await client.listTools()) {
        const access = toolAccessFor(tool, classConfig);
        // A read-only/research role only ever receives non-mutating MCP tools.
        if (!allowedForRole(access, isReadOnlyRole, allowReadOnlyRoles)) {
          hidden += 1;
          continue;
        }
        const display = mcpToolDisplayName(serverName, tool.name);
        specs.push({
          name: display,
          description: tool.description ?? `MCP tool "${tool.name}" (server: ${serverName})`,
          parameters: tool.inputSchema,
        });
        byName.set(display, { serverName, toolName: tool.name, client, access, trust });
      }
      if (hidden > 0 && isReadOnlyRole) {
        warnings.push(
          `MCP server "${serverName}": hid ${hidden} mutating tool(s) from a read-only role.`,
        );
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
