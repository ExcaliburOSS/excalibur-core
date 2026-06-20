import {
  authorize,
  closeMcp,
  connectMcpServers,
  lookupServer,
  McpTokenStore,
  openBrowser,
  registryServerToConfig,
  searchRegistry,
  startLoopback,
  type McpServerSpec,
} from '@excalibur/agent-runtime';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { readRawConfig, writeRawConfig } from '../lib/config-file';
import { loadConfigContext } from '../lib/context';

/**
 * `excalibur mcp list [--probe]` — inspect the configured Model Context Protocol
 * servers (local stdio `command` or remote Streamable-HTTP `url`). Without
 * `--probe` it just lists what's configured (fast, no connection); with `--probe`
 * it actually connects to each and lists the tools it exposes (with a clear
 * error per server that's unreachable). The inspection surface for the MCP
 * integration — both local and remote (P1.11).
 */
export function registerMcpCommand(program: Command, deps: CliDeps): void {
  const mcp = program.command('mcp').description('inspect configured MCP servers (local + remote)');

  mcp
    .command('list')
    .description('list configured MCP servers; --probe connects and lists their tools')
    .option('--probe', 'connect to each server and list its tools (network/subprocess)')
    .option('--json', 'machine-readable JSON output')
    .action(async (options: { probe?: boolean; json?: boolean }) => {
      const { config } = loadConfigContext(deps.cwd());
      const servers = config.mcp?.servers ?? {};
      const names = Object.keys(servers);

      if (!options.probe) {
        const rows = names.map((name) => {
          const cfg = servers[name] as McpServerSpec & {
            trust?: string;
            auth?: { type?: string };
          };
          const transport = cfg.url !== undefined ? 'remote (http)' : 'local (stdio)';
          const target = cfg.url ?? `${cfg.command ?? ''} ${(cfg.args ?? []).join(' ')}`.trim();
          const trust = `${cfg.trust ?? 'prompt'}${cfg.auth?.type && cfg.auth.type !== 'none' ? ` · ${cfg.auth.type}` : ''}`;
          return { name, transport, target, trust };
        });
        if (options.json === true) {
          deps.ui.json(rows);
          return;
        }
        if (rows.length === 0) {
          deps.ui.info(deps.t('mcp.none'));
          return;
        }
        deps.ui.table(
          [
            deps.t('mcp.col-name'),
            deps.t('mcp.col-transport'),
            deps.t('mcp.col-target'),
            deps.t('mcp.col-trust'),
          ],
          rows.map((r) => [r.name, r.transport, r.target, r.trust]),
        );
        deps.ui.info(deps.t('mcp.probe-hint'));
        return;
      }

      // --probe: actually connect + enumerate tools (additive; never throws).
      const connected = await connectMcpServers(servers as Record<string, McpServerSpec>);
      try {
        const byServer = new Map<string, string[]>();
        for (const [, entry] of connected.byName) {
          // Use the AUTHORITATIVE real tool name from the routing entry — never
          // re-parse the `mcp__<server>__<tool>` display name (a server name
          // containing `__` would corrupt that split).
          byServer.set(entry.serverName, [
            ...(byServer.get(entry.serverName) ?? []),
            entry.toolName,
          ]);
        }
        if (options.json === true) {
          deps.ui.json({
            servers: names.map((name) => ({ name, tools: byServer.get(name) ?? [] })),
            warnings: connected.warnings,
          });
        } else {
          for (const name of names) {
            const tools = byServer.get(name) ?? [];
            deps.ui.write(`${pc.bold(name)}  ${pc.dim(`${tools.length} tool(s)`)}`);
            for (const tool of tools) deps.ui.write(`  - ${tool}`);
          }
          for (const warning of connected.warnings) {
            deps.ui.warn(warning);
          }
        }
      } finally {
        closeMcp(connected);
      }
    });

  mcp
    .command('search')
    .description('search the curated, signed MCP server registry')
    .argument('[query]', 'name/description substring')
    .option('--json', 'machine-readable JSON output')
    .action((query: string | undefined, options: { json?: boolean }) => {
      const results = searchRegistry(query ?? '');
      if (options.json === true) {
        deps.ui.json(results);
        return;
      }
      if (results.length === 0) {
        deps.ui.info(deps.t('mcp.registry-empty'));
        return;
      }
      deps.ui.table(
        [
          deps.t('mcp.col-name'),
          deps.t('mcp.col-trust'),
          deps.t('mcp.col-score'),
          deps.t('mcp.col-desc'),
        ],
        results.map((s) => [s.name, s.trust, String(s.trustScore), s.description]),
      );
      deps.ui.info(deps.t('mcp.add-hint'));
    });

  mcp
    .command('add')
    .description('add a server from the signed registry to .excalibur/config.yaml')
    .argument('<name>', 'registry server name (see `excalibur mcp search`)')
    .action((name: string) => {
      const server = lookupServer(name);
      if (server === undefined) {
        throw new CliUsageError(deps.t('mcp.registry-unknown', { name }));
      }
      const repoRoot = deps.cwd();
      const raw = readRawConfig(repoRoot);
      const mcpSection =
        typeof raw['mcp'] === 'object' && raw['mcp'] !== null
          ? (raw['mcp'] as Record<string, unknown>)
          : {};
      const servers =
        typeof mcpSection['servers'] === 'object' && mcpSection['servers'] !== null
          ? (mcpSection['servers'] as Record<string, unknown>)
          : {};
      servers[name] = registryServerToConfig(server);
      mcpSection['servers'] = servers;
      raw['mcp'] = mcpSection;
      writeRawConfig(repoRoot, raw);
      deps.ui.success(
        deps.t('mcp.added', { name, trust: server.trust, score: String(server.trustScore) }),
      );
      if (server.transport === 'http') {
        deps.ui.info(deps.t('mcp.added-oauth-hint', { name }));
      }
    });

  mcp
    .command('auth')
    .description('authorize a remote MCP server via OAuth (Dynamic Client Registration + PKCE)')
    .argument('<name>', 'configured MCP server name')
    .action(async (name: string) => {
      const { config } = loadConfigContext(deps.cwd());
      const server = config.mcp?.servers?.[name] as
        | { url?: string; auth?: { clientId?: string; scopes?: string[] } }
        | undefined;
      if (server === undefined) {
        throw new CliUsageError(deps.t('mcp.auth-unknown', { name }));
      }
      if (server.url === undefined) {
        throw new CliUsageError(deps.t('mcp.auth-not-remote', { name }));
      }
      const serverUrl = server.url;
      deps.ui.info(deps.t('mcp.auth-starting', { name }));
      try {
        const token = await authorize(serverUrl, {
          fetchImpl: globalThis.fetch as typeof fetch,
          loopback: () => startLoopback(),
          openUrl: (url) => {
            deps.ui.info(deps.t('mcp.auth-open', { url }));
            openBrowser(url);
          },
          ...(server.auth?.clientId !== undefined ? { clientId: server.auth.clientId } : {}),
          ...(server.auth?.scopes !== undefined ? { scope: server.auth.scopes.join(' ') } : {}),
        });
        new McpTokenStore().set(serverUrl, token);
        deps.ui.success(deps.t('mcp.auth-done', { name }));
      } catch (error) {
        deps.ui.error(
          deps.t('mcp.auth-failed', {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    });
}
