import { EXCALIBUR_DIR } from '@excalibur/core';
import type { DetectedSkill } from '@excalibur/shared';
import type { Command } from 'commander';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import { upsertSourceRef, type SourceRef } from '../lib/config-file';
import { displayTrust, findSkillById, scanSkills } from '../lib/isd';

/**
 * `excalibur skills list|inspect|enable|disable` (ISD spec §7). Skills are
 * capability definitions: never auto-executed, never auto-enabled when
 * untrusted. Enabling a review_required/untrusted skill requires the
 * explicit `--accept-risk` flag — `--yes` alone is NOT enough.
 */

function configRef(skill: DetectedSkill, enabled: boolean): SourceRef {
  return {
    path: skill.scope === 'user_global' ? skill.path : `./${skill.path}`,
    scope: skill.scope,
    enabled,
    trustLevel: skill.trustLevel,
  };
}

export function registerSkillsCommand(program: Command, deps: CliDeps): void {
  const skills = program.command('skills').description('discover and govern SKILL.md capabilities');

  skills
    .command('list')
    .description('list detected skills with their trust level')
    .option('--json', 'machine-readable JSON output')
    .action(async (options: { json?: boolean }) => {
      const detected = await scanSkills(deps, deps.cwd());
      if (options.json === true) {
        deps.ui.json(detected);
        return;
      }
      if (detected.length === 0) {
        deps.ui.info(deps.t('skills.none-detected'));
        return;
      }
      deps.ui.table(
        ['ID', 'NAME', 'SCOPE', 'TRUST', 'ENABLED', 'PATH'],
        detected.map((skill) => [
          skill.id,
          skill.name,
          skill.scope,
          displayTrust({ scope: skill.scope, trustLevel: skill.trustLevel }),
          skill.enabled ? 'yes' : 'no',
          skill.path,
        ]),
      );
      deps.ui.info(deps.t('skills.list-footer'));
    });

  skills
    .command('inspect')
    .description('show the details of one skill')
    .argument('<id>', 'skill id (see skills list)')
    .action(async (id: string) => {
      const skill = findSkillById(await scanSkills(deps, deps.cwd()), id);
      deps.ui.heading(deps.t('skills.inspect-heading', { id: skill.id, name: skill.name }));
      deps.ui.write(
        deps.t('skills.inspect-description', { description: skill.description ?? '(none)' }),
      );
      deps.ui.write(deps.t('skills.inspect-path', { path: skill.path, scope: skill.scope }));
      deps.ui.write(
        deps.t('skills.inspect-trust', {
          trust: displayTrust({ scope: skill.scope, trustLevel: skill.trustLevel }),
          enabled: skill.enabled ? 'yes' : 'no',
        }),
      );
      deps.ui.write(
        deps.t('skills.inspect-triggers', {
          triggers: skill.triggers.join(', ') || '(none declared)',
        }),
      );
      deps.ui.write(
        deps.t('skills.inspect-dependencies', {
          dependencies: skill.dependencies.join(', ') || '(none declared)',
        }),
      );
      deps.ui.write(
        deps.t('skills.inspect-tools', {
          tools: skill.toolsRequired.join(', ') || '(none declared)',
        }),
      );
    });

  skills
    .command('enable')
    .description('enable a skill (review_required skills need --accept-risk)')
    .argument('<id>', 'skill id')
    .option('--accept-risk', 'explicitly accept enabling a skill that needs review')
    .option('-y, --yes', 'skip prompts (NOT enough for review_required skills)')
    .action(async (id: string, options: { acceptRisk?: boolean; yes?: boolean }) => {
      const repoRoot = deps.cwd();
      const skill = findSkillById(await scanSkills(deps, repoRoot), id);

      if (skill.trustLevel !== 'trusted') {
        if (options.acceptRisk !== true) {
          // Contract §4.9: --yes alone is NOT enough for review_required skills —
          // --accept-risk is the explicit confirmation.
          throw new CliUsageError(
            deps.t('skills.enable-needs-accept-risk', {
              id,
              trustLevel: skill.trustLevel,
              path: skill.path,
            }),
          );
        }
        deps.ui.warn(
          deps.t('skills.enable-risk-accepted', { trustLevel: skill.trustLevel, name: skill.name }),
        );
      }

      upsertSourceRef(repoRoot, 'skills', configRef(skill, true));
      deps.ui.success(deps.t('skills.enabled', { id, dir: EXCALIBUR_DIR }));
      deps.ui.info(deps.t('skills.enabled-footer'));
    });

  skills
    .command('disable')
    .description('disable a skill (persisted to config.yaml)')
    .argument('<id>', 'skill id')
    .action(async (id: string) => {
      const repoRoot = deps.cwd();
      const skill = findSkillById(await scanSkills(deps, repoRoot), id);
      upsertSourceRef(repoRoot, 'skills', configRef(skill, false));
      deps.ui.success(deps.t('skills.disabled', { id, dir: EXCALIBUR_DIR }));
    });
}
