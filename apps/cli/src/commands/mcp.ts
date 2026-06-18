import { closeMcp, connectMcpServers, type McpServerSpec } from '@excalibur/agent-runtime';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { CliDeps } from '../deps';
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
          const cfg = servers[name] as McpServerSpec;
          const transport = cfg.url !== undefined ? 'remote (http)' : 'local (stdio)';
          const target = cfg.url ?? `${cfg.command ?? ''} ${(cfg.args ?? []).join(' ')}`.trim();
          return { name, transport, target };
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
          [deps.t('mcp.col-name'), deps.t('mcp.col-transport'), deps.t('mcp.col-target')],
          rows.map((r) => [r.name, r.transport, r.target]),
        );
        deps.ui.info(deps.t('mcp.probe-hint'));
        return;
      }

      // --probe: actually connect + enumerate tools (additive; never throws).
      const connected = await connectMcpServers(servers as Record<string, McpServerSpec>);
      try {
        const byServer = new Map<string, string[]>();
        for (const [display, entry] of connected.byName) {
          const tool = display.split('__').slice(2).join('__');
          byServer.set(entry.serverName, [...(byServer.get(entry.serverName) ?? []), tool]);
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
}
