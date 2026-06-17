import {
  buildTurnSummary,
  classifyTaskIntent,
  loadReplay,
  MESH_LENSES,
  planVerificationMesh,
  reconstructStateAt,
} from '@excalibur/core';
import { analyzeRepository } from '@excalibur/context-engine';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { CliDeps } from '../deps';
import { loadConfigContext, loadGatewayContext, requireConfiguredModel } from '../lib/context';
import { resolveRun } from '../lib/replay-scrubber';
import { runVerificationMesh } from '../lib/verification';

/**
 * `excalibur verify [id]` — runs the adversarial VERIFICATION MESH over a run's
 * changes: proportional (the lens set scales to the change's risk) + governable
 * (`ui.verification.mesh`). N isolated jurors refute the diff in parallel; a
 * surviving HIGH issue is reported as BLOCKING. Real model required.
 */
export function registerVerifyCommand(program: Command, deps: CliDeps): void {
  program
    .command('verify')
    .description("adversarial Verification Mesh over a run's changes (proportional, isolated jurors)")
    .argument('[id]', 'run id (defaults to the latest run)')
    .action(async (id: string | undefined) => {
      const repoRoot = deps.cwd();
      const { config } = loadConfigContext(repoRoot);
      const gateway = loadGatewayContext(repoRoot);
      requireConfiguredModel(gateway, deps.t); // the mesh runs REAL verifier lenses

      const { id: runId } = resolveRun(deps, id);
      const model = loadReplay(repoRoot, runId);
      const last = model.steps.length - 1;
      const diff = last >= 0 ? reconstructStateAt(model, last).accumulatedDiff : '';
      if (diff.trim().length === 0) {
        deps.ui.info(deps.t('verify.no-changes', { runId }));
        return;
      }

      const summary = buildTurnSummary(model);
      const analysis = await analyzeRepository(repoRoot, {
        homeDir: deps.homeDir(),
        includeUserGlobal: deps.includeUserGlobal,
      });
      const intent = classifyTaskIntent(model.run.title, analysis, config);
      const plan = planVerificationMesh({
        taskType: intent.taskType,
        sensitive: intent.sensitive,
        affectedUnits: summary.metrics.files,
        autonomyLevel: model.run.autonomyLevel ?? intent.recommendedAutonomy,
        hasTests: typeof config.commands?.test === 'string',
        ...(config.verification?.mesh !== undefined ? { mode: config.verification.mesh } : {}),
      });

      deps.ui.info(deps.t('verify.plan', { reason: plan.reason }));
      if (plan.lenses.length === 0) {
        return; // proportional: nothing warranted
      }
      deps.ui.info(
        deps.t('verify.running', {
          lenses: plan.lenses.map((l) => MESH_LENSES[l].label).join(', '),
        }),
      );

      const result = await runVerificationMesh({
        diff,
        lenses: plan.lenses,
        gateway: gateway.gateway,
        provider: gateway.providerName,
      });

      deps.ui.write();
      if (result.blocked) {
        deps.ui.error(result.summary);
      } else {
        deps.ui.success(result.summary);
      }
      for (const issue of result.issues) {
        const sev = issue.severity.toUpperCase();
        const where = issue.file !== undefined ? `${issue.file} — ` : '';
        deps.ui.write(`  ${pc.dim(`[${sev}]`)} ${where}${issue.problem}`);
        if (issue.fix !== undefined) {
          deps.ui.write(`     ${pc.dim(`→ ${issue.fix}`)}`);
        }
      }
    });
}
