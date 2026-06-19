import { createExtensionHost } from '@excalibur/core';
import type { WorkflowDefinition } from '@excalibur/workflow-schema';
import type { Command } from 'commander';
import pc from 'picocolors';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';

/**
 * `excalibur workflows list|explain <id>` — the catalog comes from the
 * extension host (built-ins + project `.excalibur/workflows/` overrides),
 * never from raw constants (Build Contract §4.9).
 */
export function registerWorkflowsCommand(program: Command, deps: CliDeps): void {
  const workflows = program.command('workflows').description('inspect the workflow catalog');

  workflows
    .command('list')
    .description('list every available workflow with its source')
    .option('--json', 'machine-readable JSON output')
    .action(async (options: { json?: boolean }) => {
      const registry = await createExtensionHost(deps.cwd());
      const contributions = registry.contributions.list('workflow');
      if (options.json === true) {
        deps.ui.json(
          contributions.map((contribution) => ({
            id: contribution.id,
            source: contribution.source,
            definition: contribution.definition,
          })),
        );
        return;
      }
      deps.ui.table(
        ['ID', 'NAME', 'MODE', 'LEVELS', 'SOURCE'],
        contributions.map((contribution) => {
          const definition = contribution.definition as WorkflowDefinition;
          return [
            definition.id,
            definition.name,
            definition.mode,
            (definition.supportedAutonomyLevels ?? []).join(','),
            contribution.source,
          ];
        }),
      );
      const warnings = registry.contributions.warnings();
      for (const warning of warnings) {
        deps.ui.warn(warning);
      }
      deps.ui.write();
      deps.ui.info(deps.t('workflows.explain-hint'));
    });

  workflows
    .command('explain')
    .description('show the phases, levels and artifacts of a workflow')
    .argument('<id>', 'workflow id')
    .action(async (id: string) => {
      const registry = await createExtensionHost(deps.cwd());
      const definition = registry.contributions.workflows().find((workflow) => workflow.id === id);
      if (definition === undefined) {
        const known = registry.contributions
          .workflows()
          .map((workflow) => workflow.id)
          .join(', ');
        throw new CliUsageError(deps.t('workflows.unknown', { id, known }));
      }

      deps.ui.heading(deps.t('workflows.title', { name: definition.name, id: definition.id }));
      if (definition.description !== undefined) {
        deps.ui.write(definition.description.trim());
      }
      deps.ui.write(deps.t('workflows.mode', { mode: definition.mode }));
      deps.ui.write(
        deps.t('workflows.levels', {
          levels: (definition.supportedAutonomyLevels ?? []).join(', '),
        }),
      );
      deps.ui.write();
      deps.ui.heading(deps.t('workflows.phases-heading'));
      definition.phases.forEach((phase, index) => {
        const parts = [
          `${index + 1}. ${phase.name} ${pc.dim(`[${phase.type}]`)}`,
          phase.role !== undefined
            ? pc.dim(deps.t('workflows.phase-role', { role: phase.role }))
            : '',
          phase.required === false ? pc.dim(deps.t('workflows.phase-optional')) : '',
          phase.approval !== undefined && phase.approval !== 'none'
            ? pc.yellow(deps.t('workflows.phase-approval', { approval: phase.approval }))
            : '',
          phase.requiresHumanConfirmation === true
            ? pc.yellow(deps.t('workflows.phase-confirmation'))
            : '',
        ].filter((part) => part.length > 0);
        deps.ui.write(`  ${parts.join('  ')}`);
      });
      const artifacts = definition.phases
        .map((phase) => phase.output)
        .filter((output): output is string => output !== undefined);
      if (artifacts.length > 0) {
        deps.ui.write();
        deps.ui.write(deps.t('workflows.artifacts', { artifacts: artifacts.join(', ') }));
      }
    });
}
