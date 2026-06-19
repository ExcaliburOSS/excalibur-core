import { createExtensionHost } from '@excalibur/core';
import type { Methodology } from '@excalibur/workflow-schema';
import type { Command } from 'commander';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';

/**
 * `excalibur methodologies list|explain <id>` — methodologies from the
 * contribution registry with their source (built_in/project/local).
 */
export function registerMethodologiesCommand(program: Command, deps: CliDeps): void {
  const methodologies = program
    .command('methodologies')
    .description('inspect the methodology catalog');

  methodologies
    .command('list')
    .description('list every available methodology with its source')
    .option('--json', 'machine-readable JSON output')
    .action(async (options: { json?: boolean }) => {
      const registry = await createExtensionHost(deps.cwd());
      const contributions = registry.contributions.list('methodology');
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
        ['ID', 'NAME', 'CATEGORY', 'LEVELS', 'RISK', 'SOURCE'],
        contributions.map((contribution) => {
          const definition = contribution.definition as Methodology;
          return [
            definition.id,
            definition.name,
            definition.category ?? 'delivery',
            (definition.recommendedAutonomyLevels ?? []).join(','),
            definition.riskProfile ?? 'medium',
            contribution.source,
          ];
        }),
      );
      for (const warning of registry.contributions.warnings()) {
        deps.ui.warn(warning);
      }
    });

  methodologies
    .command('explain')
    .description('show when to use (and avoid) a methodology')
    .argument('<id>', 'methodology id')
    .action(async (id: string) => {
      const registry = await createExtensionHost(deps.cwd());
      const definition = registry.contributions
        .methodologies()
        .find((methodology) => methodology.id === id);
      if (definition === undefined) {
        const known = registry.contributions
          .methodologies()
          .map((methodology) => methodology.id)
          .join(', ');
        throw new CliUsageError(deps.t('methodologies.unknown', { id, known }));
      }
      deps.ui.heading(
        deps.t('methodologies.heading', { name: definition.name, id: definition.id }),
      );
      deps.ui.write(definition.description.trim());
      if (definition.useWhen !== undefined && definition.useWhen.length > 0) {
        deps.ui.write();
        deps.ui.heading(deps.t('methodologies.use-when'));
        for (const line of definition.useWhen) deps.ui.write(`  - ${line}`);
      }
      if (definition.avoidWhen !== undefined && definition.avoidWhen.length > 0) {
        deps.ui.write();
        deps.ui.heading(deps.t('methodologies.avoid-when'));
        for (const line of definition.avoidWhen) deps.ui.write(`  - ${line}`);
      }
      if (definition.defaultWorkflow !== undefined) {
        deps.ui.write();
        deps.ui.write(
          deps.t('methodologies.default-workflow', { workflow: definition.defaultWorkflow }),
        );
      }
      if (definition.phases !== undefined && definition.phases.length > 0) {
        deps.ui.write(deps.t('methodologies.phases', { phases: definition.phases.join(' → ') }));
      }
      deps.ui.write(
        deps.t('methodologies.risk-profile', { risk: definition.riskProfile ?? 'medium' }),
      );
    });
}
