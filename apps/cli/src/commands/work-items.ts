import { execFile } from 'node:child_process';
import { GitHubCliProvider, type GhRunner, type NormalizedWorkItem } from '@excalibur/work-items';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { runTask } from '../lib/run-pipeline';

/**
 * `excalibur work-items …` (plan P2.9) — a REAL GitHub Issues provider over the
 * `gh` CLI passthrough (gh holds the auth; Excalibur stores no token). The
 * differentiator vs CC/OpenCode (badge-only / MCP-only) is `work-items run`:
 * fetch a ticket and run it as an agentic task — the agent-native bridge from
 * issue → code, with opt-in comment-back. Read paths are safe + offline-testable;
 * writes (comment / status) are explicit.
 */

/** A `gh` runner that shells out to the installed, authenticated CLI. */
function ghRunner(): GhRunner {
  return (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile('gh', args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message).trim()));
        } else {
          resolve(stdout);
        }
      });
    });
}

function providerFor(repo: string | undefined): GitHubCliProvider {
  return new GitHubCliProvider(ghRunner(), repo);
}

function statusColor(status: string | null): string {
  return status === 'open' ? pc.green(status) : status === 'closed' ? pc.dim(status) : pc.yellow(status ?? '—');
}

function printItem(deps: CliDeps, wi: NormalizedWorkItem): void {
  deps.ui.write(`${pc.bold(wi.key)}  ${statusColor(wi.status)}`);
  deps.ui.write(`  ${wi.title}`);
  if (wi.labels.length > 0) deps.ui.write(pc.dim(`  labels: ${wi.labels.join(', ')}`));
  deps.ui.write(pc.dim(`  ${wi.url}`));
}

export function registerWorkItemsCommand(program: Command, deps: CliDeps): void {
  const wi = program
    .command('work-items')
    .alias('issues')
    .description('GitHub Issues via the gh CLI (list/show/run/comment) — agent-native work items');

  wi.command('list')
    .description('list issues (gh issue list)')
    .option('--repo <owner/name>', 'target repo (default: the current repo remote)')
    .option('--state <open|closed|all>', 'filter by state', 'open')
    .option('--limit <n>', 'max items', '30')
    .option('--json', 'machine-readable JSON')
    .action(async (options: { repo?: string; state?: string; limit?: string; json?: boolean }) => {
      const provider = providerFor(options.repo);
      const items = await provider.listWorkItems({
        integrationId: 'local',
        limit: Number.parseInt(options.limit ?? '30', 10) || 30,
        ...(options.state === 'open' || options.state === 'closed' ? { status: options.state } : {}),
      });
      if (options.json === true) {
        deps.ui.json(items);
        return;
      }
      if (items.length === 0) {
        deps.ui.info(deps.t('work-items.none'));
        return;
      }
      for (const item of items) {
        printItem(deps, item);
        deps.ui.write();
      }
    });

  wi.command('show')
    .description('show one issue with its body + comments (gh issue view)')
    .argument('<number>', 'issue number')
    .option('--repo <owner/name>', 'target repo')
    .option('--json', 'machine-readable JSON')
    .action(async (number: string, options: { repo?: string; json?: boolean }) => {
      const item = await providerFor(options.repo).getWorkItem({
        integrationId: 'local',
        externalIdOrKey: number,
      });
      if (options.json === true) {
        deps.ui.json(item);
        return;
      }
      printItem(deps, item);
      if (item.description !== null && item.description.length > 0) {
        deps.ui.write();
        deps.ui.write(item.description);
      }
      if (item.comments.length > 0) {
        deps.ui.write();
        deps.ui.write(pc.dim(deps.t('work-items.comments', { count: item.comments.length })));
        for (const c of item.comments) {
          deps.ui.write(`  ${pc.dim(`${c.author?.name ?? 'someone'}:`)} ${c.body.replace(/\s+/g, ' ').slice(0, 200)}`);
        }
      }
    });

  wi.command('comment')
    .description('comment on an issue (gh issue comment) — WRITES to GitHub')
    .argument('<number>', 'issue number')
    .argument('<body...>', 'the comment text')
    .option('--repo <owner/name>', 'target repo')
    .action(async (number: string, bodyWords: string[], options: { repo?: string }) => {
      const body = bodyWords.join(' ').trim();
      if (body.length === 0) {
        throw new CliUsageError(deps.t('work-items.comment-empty'));
      }
      await providerFor(options.repo).addComment({
        integrationId: 'local',
        externalIdOrKey: number,
        body,
      });
      deps.ui.success(deps.t('work-items.commented', { number }));
    });

  wi.command('run')
    .description('fetch an issue and run it as an agentic task (the agent-native bridge)')
    .argument('<number>', 'issue number')
    .option('--repo <owner/name>', 'target repo')
    .option('--comment', 'comment the outcome back to the issue when done (WRITES to GitHub)')
    .option('--careful', 'run at Level 4 with stronger approvals')
    .option('-y, --yes', 'skip prompts and accept safe defaults')
    .action(async (number: string, options: { repo?: string; comment?: boolean; careful?: boolean; yes?: boolean }) => {
      const provider = providerFor(options.repo);
      const item = await provider.getWorkItem({ integrationId: 'local', externalIdOrKey: number });
      deps.ui.info(deps.t('work-items.running', { key: item.key, title: item.title }));
      const task = `${item.title}\n\n${item.description ?? ''}`.trim();
      const record = await runTask(deps, task, {
        ...(options.careful === true ? { style: 'careful' as const } : {}),
        ...(options.yes === true ? { yes: true } : {}),
      });
      if (record === null) {
        return; // cancelled or diverted to Discovery
      }
      if (options.comment === true) {
        const status = record.status === 'completed' ? '✓ completed' : `⚠ ${record.status}`;
        await provider.addComment({
          integrationId: 'local',
          externalIdOrKey: number,
          body: `Excalibur ran this task — ${status} (run ${record.id}).`,
        });
        deps.ui.success(deps.t('work-items.commented', { number }));
      }
    });
}
