import { getGitInfo } from '@excalibur/core';
import type { Command } from 'commander';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import { loadConfigContext, loadGatewayContext, requireConfiguredModel } from '../lib/context';
import { runSwarmFlow } from '../lib/swarm';
import {
  latestOrchestrationRunId,
  loadOrchestrationManifest,
  manifestToSubtasks,
} from '../lib/orchestration-manifest';

/**
 * `excalibur orchestrate [runId] [--resume]` (AO5) — re-run (or resume) a past
 * parallel orchestration from its persisted `orchestration.json` manifest. This
 * is the repeatable/crash-recoverable half of Claude-Code Workflow-tool parity:
 * the run is a first-class artifact you can re-execute deterministically.
 *  - default: re-run ALL lanes of the latest orchestration.
 *  - `--resume`: re-dispatch ONLY the lanes that did not complete (failed/empty).
 */
export function registerOrchestrateCommand(program: Command, deps: CliDeps): void {
  program
    .command('orchestrate')
    .description('re-run or resume a past orchestration from its saved manifest')
    .argument('[runId]', 'the orchestration parent run (default: the latest)')
    .option('--resume', 're-dispatch only the lanes that did not complete')
    .option('-y, --yes', 'apply the merged result without prompting')
    .action(async (runIdArg: string | undefined, options: { resume?: boolean; yes?: boolean }) => {
      const repoRoot = deps.cwd();
      if (!getGitInfo(repoRoot).isRepo) {
        throw new CliUsageError(deps.t('swarm.needsGitRepo'));
      }
      const runId = runIdArg ?? latestOrchestrationRunId(repoRoot) ?? undefined;
      if (runId === undefined) {
        throw new CliUsageError(deps.t('orchestrate.none'));
      }
      const manifest = loadOrchestrationManifest(repoRoot, runId);
      if (manifest === null) {
        throw new CliUsageError(deps.t('orchestrate.noManifest', { runId }));
      }
      const subtasks = manifestToSubtasks(manifest, { resume: options.resume === true });
      if (subtasks.length === 0) {
        deps.ui.info(deps.t('orchestrate.nothingToDo'));
        return;
      }
      const gateway = loadGatewayContext(repoRoot);
      requireConfiguredModel(gateway, deps.t);
      const { config } = loadConfigContext(repoRoot);
      deps.ui.info(
        deps.t(options.resume === true ? 'orchestrate.resuming' : 'orchestrate.rerunning', {
          n: subtasks.length,
          runId,
        }),
      );
      await runSwarmFlow(
        deps,
        repoRoot,
        manifest.task,
        { gateway: gateway.gateway, providerName: gateway.providerName, config },
        { subtasks, ...(options.yes === true ? { yes: true } : {}) },
      );
    });
}
