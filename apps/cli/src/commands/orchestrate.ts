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
import { loadAuthoredOrchestration } from '../lib/authored-orchestration';

/**
 * `excalibur orchestrate [runId] [--resume]` (AO5) — re-run (or resume) a past
 * parallel orchestration from its persisted `orchestration.json` manifest. This
 * is the repeatable/crash-recoverable half of Claude-Code Workflow-tool parity:
 * the run is a first-class artifact you can re-execute deterministically.
 *  - default: re-run ALL lanes of the latest orchestration.
 *  - `--resume`: re-dispatch ONLY the lanes that did not complete (failed/empty).
 *  - `--spec <name|path>` (AO5-4): run an AUTHOR-defined orchestration — a
 *    committed `.excalibur/orchestrations/<name>.yaml` (or a file path) of named
 *    steps that compiles to the dependency-wave swarm. The opt-in, hand-authored
 *    DAG; auto-orchestration stays the default for plain build prompts.
 */
export function registerOrchestrateCommand(program: Command, deps: CliDeps): void {
  program
    .command('orchestrate')
    .description('run an authored spec, or re-run/resume a past orchestration from its manifest')
    .argument('[runId]', 'the orchestration parent run (default: the latest)')
    .option('--resume', 're-dispatch only the lanes that did not complete')
    .option('--spec <name|path>', 'run an authored orchestration spec (YAML of named steps)')
    .option('-y, --yes', 'apply the merged result without prompting')
    .action(
      async (
        runIdArg: string | undefined,
        options: { resume?: boolean; yes?: boolean; spec?: string },
      ) => {
        const repoRoot = deps.cwd();
        if (!getGitInfo(repoRoot).isRepo) {
          throw new CliUsageError(deps.t('swarm.needsGitRepo'));
        }
        // AO5-4 — AUTHOR spec path: compile the YAML → SwarmSubtask[] → staged swarm.
        if (options.spec !== undefined) {
          const { task, subtasks, path } = loadAuthoredOrchestration(repoRoot, options.spec);
          const gw = loadGatewayContext(repoRoot);
          requireConfiguredModel(gw, deps.t);
          const { config: cfg } = loadConfigContext(repoRoot);
          deps.ui.info(deps.t('orchestrate.runningSpec', { n: subtasks.length, path }));
          await runSwarmFlow(
            deps,
            repoRoot,
            task,
            { gateway: gw.gateway, providerName: gw.providerName, config: cfg },
            { subtasks, ...(options.yes === true ? { yes: true } : {}) },
          );
          return;
        }
        await runManifestOrchestration(deps, repoRoot, runIdArg, options);
      },
    );
}

/** The AO5-3 re-run / resume path: reconstruct lanes from a persisted manifest. */
async function runManifestOrchestration(
  deps: CliDeps,
  repoRoot: string,
  runIdArg: string | undefined,
  options: { resume?: boolean; yes?: boolean },
): Promise<void> {
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
}
