import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCustomAgents, resolveCustomAgent, type CustomAgent } from '@excalibur/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';

/**
 * `excalibur agents list|show|init` (P1.7) — self-contained custom agents.
 *
 * A single markdown file under `.excalibur/agents/<name>.md` (project) or
 * `~/.config/excalibur/agents/<name>.md` (user-global) defines a selectable
 * agent: its persona (the body), model, temperature, role, native-tool
 * allowlist and permission overrides. Run one with `excalibur run --agent <name>`.
 */

const EXAMPLE_AGENT = `---
name: Security Reviewer
description: Adversarial, read-only security review
role: security
# model: kimi-k2.7-code      # a model id (optional)
# provider: kimi             # a providers.yaml key (optional)
temperature: 0.1
tools: [read_file, list_files, search_code, git_diff, web_search]
permissions:
  tools:
    write_file: false
    run_command: false
  deniedCommands:
    - 'git push*'
---

You are a meticulous security reviewer. Read the actual changes and hunt for
what is WRONG: injection, secret handling, auth gaps, unsafe shell/network,
and data exposure. List each issue as:

  [severity high|medium|low] <file>:<where> — <problem> → <concrete fix>

Never rubber-stamp. If after a genuine hunt you find nothing, say so and state
exactly what you verified.
`;

function describeAgent(deps: CliDeps, agent: CustomAgent): void {
  deps.ui.heading(`${agent.displayName} ${pc.dim(`(${agent.name})`)}`);
  deps.ui.write(agent.description);
  deps.ui.write();
  const facts: Array<[string, string | undefined]> = [
    ['Role', agent.role],
    ['Model', agent.model],
    ['Provider', agent.provider],
    ['Temperature', agent.temperature !== undefined ? String(agent.temperature) : undefined],
    ['Tools', agent.tools !== undefined ? agent.tools.join(', ') : 'all (role default)'],
    ['Source', `${agent.source} — ${agent.path}`],
  ];
  for (const [label, value] of facts) {
    if (value !== undefined) {
      deps.ui.write(`${pc.bold(label)}: ${value}`);
    }
  }
  if (agent.permissions !== undefined) {
    deps.ui.write(`${pc.bold('Permissions')}: ${JSON.stringify(agent.permissions)}`);
  }
  deps.ui.write();
  deps.ui.heading('System prompt');
  deps.ui.write(agent.systemPrompt);
}

export function registerAgentsCommand(program: Command, deps: CliDeps): void {
  const agents = program
    .command('agents')
    .description('list, inspect and scaffold self-contained custom agents');

  agents
    .command('list')
    .description('list available custom agents (project + user-global)')
    .option('--json', 'machine-readable JSON output')
    .action((options: { json?: boolean }) => {
      const found = loadCustomAgents({
        repoRoot: deps.cwd(),
        homeDir: deps.homeDir(),
        includeGlobal: deps.includeUserGlobal,
      });
      const list = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
      if (options.json === true) {
        deps.ui.json(
          list.map((a) => ({
            name: a.name,
            displayName: a.displayName,
            description: a.description,
            role: a.role ?? null,
            model: a.model ?? null,
            provider: a.provider ?? null,
            source: a.source,
            path: a.path,
          })),
        );
        return;
      }
      if (list.length === 0) {
        deps.ui.info('No custom agents yet.');
        deps.ui.info('Create one with `excalibur agents init <name>`, then `run --agent <name>`.');
        return;
      }
      deps.ui.table(
        ['NAME', 'ROLE', 'MODEL', 'SOURCE', 'DESCRIPTION'],
        list.map((a) => [
          a.name,
          a.role ?? '-',
          a.model ?? a.provider ?? '-',
          a.source,
          a.description,
        ]),
      );
      deps.ui.write();
      deps.ui.info('Run one with: excalibur run "<task>" --agent <name>');
    });

  agents
    .command('show')
    .description('show one custom agent in full (persona + config)')
    .argument('<name>', 'agent name (the file basename)')
    .action((name: string) => {
      const agent = resolveCustomAgent(name, {
        repoRoot: deps.cwd(),
        homeDir: deps.homeDir(),
        includeGlobal: deps.includeUserGlobal,
      });
      if (agent === null) {
        throw new CliUsageError(
          `unknown agent "${name}". Run \`excalibur agents list\` to see what's available.`,
        );
      }
      describeAgent(deps, agent);
    });

  agents
    .command('init')
    .description('scaffold a starter custom agent at .excalibur/agents/<name>.md')
    .argument('<name>', 'agent name (the file basename)')
    .action((name: string) => {
      const safe = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      if (safe.length === 0) {
        throw new CliUsageError('agent name must contain a letter or digit.');
      }
      const dir = join(deps.cwd(), '.excalibur', 'agents');
      const file = join(dir, `${safe}.md`);
      if (existsSync(file)) {
        throw new CliUsageError(`agent "${safe}" already exists at ${file}.`);
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, EXAMPLE_AGENT, 'utf8');
      deps.ui.success(`Created ${file}`);
      deps.ui.info(`Edit it, then run: excalibur run "<task>" --agent ${safe}`);
    });
}
