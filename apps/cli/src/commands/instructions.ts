import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EXCALIBUR_DIR } from '@excalibur/core';
import { redactSecrets } from '@excalibur/model-gateway';
import type { InstructionSource } from '@excalibur/shared';
import type { Command } from 'commander';
import pc from 'picocolors';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import { upsertSourceRef, type SourceRef } from '../lib/config-file';
import { displayTrust, findSourceById, scanSources } from '../lib/isd';

/**
 * `excalibur instructions scan|list|inspect|enable|disable|import|doctor`
 * (ISD spec §7). Enable/disable persist into config.yaml; `import` copies a
 * source into `.excalibur/instructions/` — user-global sources require the
 * explicit `--include-global` flag (bare `--yes` is never enough).
 */

function absolutePathOf(deps: CliDeps, repoRoot: string, source: InstructionSource): string {
  const fromMetadata = source.metadata['absolutePath'];
  if (typeof fromMetadata === 'string' && fromMetadata.length > 0) {
    return fromMetadata;
  }
  if (source.path.startsWith('~/')) {
    return join(deps.homeDir(), source.path.slice(2));
  }
  return join(repoRoot, source.path);
}

function configRef(source: InstructionSource): SourceRef {
  const isGlobal = source.scope === 'user_global';
  return {
    path: isGlobal ? source.path : `./${source.path}`,
    format: source.format,
    scope: source.scope,
    enabled: source.enabled,
    ...(isGlobal ? { localOnly: true } : {}),
  };
}

export function registerInstructionsCommand(program: Command, deps: CliDeps): void {
  const instructions = program
    .command('instructions')
    .description('discover and govern existing AI instruction files (ISD)');

  instructions
    .command('scan')
    .description('scan the repository (and home) for instruction sources')
    .option('--json', 'machine-readable JSON output')
    .action(async (options: { json?: boolean }) => {
      const sources = await scanSources(deps, deps.cwd());
      if (options.json === true) {
        deps.ui.json(sources);
        return;
      }
      const project = sources.filter(
        (source) => source.scope === 'project' && source.kind === 'instruction',
      );
      const context = sources.filter((source) => source.kind === 'context');
      const skills = sources.filter((source) => source.kind === 'skill');
      const global = sources.filter((source) => source.scope === 'user_global');

      if (project.length > 0) {
        deps.ui.heading(deps.t('instructions.scanProjectHeading'));
        for (const source of project) deps.ui.success(`  ${source.path} (${source.format})`);
      }
      if (skills.length > 0) {
        deps.ui.heading(deps.t('instructions.scanSkillsHeading'));
        for (const source of skills) deps.ui.warn(`  ${source.path} (${source.trustLevel})`);
      }
      if (global.length > 0) {
        deps.ui.heading(deps.t('instructions.scanGlobalHeading'));
        for (const source of global) deps.ui.warn(`  ${source.path}`);
      }
      if (context.length > 0) {
        deps.ui.heading(deps.t('instructions.scanContextHeading'));
        for (const source of context.filter((s) => s.scope !== 'user_global')) {
          deps.ui.info(`  ${source.path}`);
        }
      }
      if (sources.length === 0) {
        deps.ui.info(deps.t('instructions.noneDetected'));
      }
      deps.ui.write();
      deps.ui.info(deps.t('instructions.scanManageHint'));
    });

  instructions
    .command('list')
    .description('list detected instruction sources')
    .option('--json', 'machine-readable JSON output')
    .action(async (options: { json?: boolean }) => {
      const sources = await scanSources(deps, deps.cwd());
      if (options.json === true) {
        deps.ui.json(sources);
        return;
      }
      if (sources.length === 0) {
        deps.ui.info(deps.t('instructions.noneDetected'));
        return;
      }
      deps.ui.table(
        ['ID', 'TYPE', 'SCOPE', 'TRUST', 'ENABLED', 'PATH'],
        sources.map((source) => [
          source.id,
          source.format,
          source.scope,
          displayTrust(source),
          source.enabled ? 'yes' : 'no',
          source.path,
        ]),
      );
    });

  instructions
    .command('inspect')
    .description('show the details of one instruction source')
    .argument('<id>', 'source id (see instructions list)')
    .action(async (id: string) => {
      const repoRoot = deps.cwd();
      const source = findSourceById(await scanSources(deps, repoRoot), id);
      deps.ui.heading(`${source.id} — ${source.title ?? basename(source.path)}`);
      deps.ui.write(deps.t('instructions.inspectPath', { path: source.path }));
      deps.ui.write(
        deps.t('instructions.inspectFormat', {
          format: source.format,
          kind: source.kind,
          scope: source.scope,
        }),
      );
      deps.ui.write(
        deps.t('instructions.inspectTrust', {
          trust: displayTrust(source),
          enabled: source.enabled ? 'yes' : 'no',
        }),
      );
      deps.ui.write(deps.t('instructions.inspectContentHash', { hash: source.contentHash }));
      const absPath = absolutePathOf(deps, repoRoot, source);
      if (existsSync(absPath)) {
        const content = redactSecrets(readFileSync(absPath, 'utf8'));
        const preview = content.split('\n').slice(0, 12).join('\n');
        deps.ui.write();
        deps.ui.write(pc.dim(preview));
        if (content.split('\n').length > 12) {
          deps.ui.info(deps.t('instructions.truncated'));
        }
      }
    });

  instructions
    .command('enable')
    .description('enable an instruction source (persisted to config.yaml)')
    .argument('<id>', 'source id')
    .action(async (id: string) => {
      const repoRoot = deps.cwd();
      const source = findSourceById(await scanSources(deps, repoRoot), id);
      upsertSourceRef(repoRoot, 'instructions', { ...configRef(source), enabled: true });
      deps.ui.success(deps.t('instructions.enabled', { id, dir: EXCALIBUR_DIR }));
    });

  instructions
    .command('disable')
    .description('disable an instruction source (persisted to config.yaml)')
    .argument('<id>', 'source id')
    .action(async (id: string) => {
      const repoRoot = deps.cwd();
      const source = findSourceById(await scanSources(deps, repoRoot), id);
      upsertSourceRef(repoRoot, 'instructions', { ...configRef(source), enabled: false });
      deps.ui.success(deps.t('instructions.disabled', { id, dir: EXCALIBUR_DIR }));
    });

  instructions
    .command('import')
    .description('copy an instruction source into .excalibur/instructions/')
    .argument('<id>', 'source id')
    .option('--include-global', 'explicitly allow importing a user-global source')
    .option('-y, --yes', 'skip the confirmation prompt (project sources only)')
    .action(async (id: string, options: { includeGlobal?: boolean; yes?: boolean }) => {
      const repoRoot = deps.cwd();
      const source = findSourceById(await scanSources(deps, repoRoot), id);

      if (source.scope === 'user_global' && options.includeGlobal !== true) {
        // ISD §3/§7: user-global files are NEVER copied into the repository
        // without explicit consent — bare --yes is not enough.
        throw new CliUsageError(
          deps.t('instructions.importGlobalBlocked', { id, path: source.path }),
        );
      }

      // For user-global sources --include-global is the explicit consent
      // (guarded above); the [Y/n] prompt still shows on interactive runs.
      const confirmed = await deps.ui.confirm(
        deps.t('instructions.importConfirm', { path: source.path, dir: EXCALIBUR_DIR }),
        { yes: options.yes === true || options.includeGlobal === true, defaultYes: true },
      );
      if (!confirmed) {
        deps.ui.info(deps.t('instructions.importCancelled'));
        return;
      }

      const absPath = absolutePathOf(deps, repoRoot, source);
      if (!existsSync(absPath)) {
        throw new CliUsageError(deps.t('instructions.sourceMissing', { path: source.path }));
      }
      const targetDir = join(repoRoot, EXCALIBUR_DIR, 'instructions');
      mkdirSync(targetDir, { recursive: true });
      const target = join(targetDir, basename(absPath));
      // Never import secrets from instruction files (ISD §3).
      const content = redactSecrets(readFileSync(absPath, 'utf8'));
      if (content === readFileSync(absPath, 'utf8')) {
        copyFileSync(absPath, target);
      } else {
        writeFileSync(target, content, 'utf8');
        deps.ui.warn(deps.t('instructions.importRedacted'));
      }
      deps.ui.success(deps.t('instructions.imported', { path: source.path, target }));
    });

  instructions
    .command('doctor')
    .description('flag missing or changed instruction sources')
    .action(async () => {
      const repoRoot = deps.cwd();
      const sources = await scanSources(deps, repoRoot);
      const lockPath = join(repoRoot, EXCALIBUR_DIR, 'cache', 'instruction-sources.json');
      let previous: Record<string, string> = {};
      if (existsSync(lockPath)) {
        try {
          previous = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, string>;
        } catch {
          previous = {};
        }
      }

      let problems = 0;
      for (const source of sources) {
        const absPath = absolutePathOf(deps, repoRoot, source);
        if (!existsSync(absPath)) {
          problems += 1;
          deps.ui.error(deps.t('instructions.doctorMissing', { path: source.path }));
          continue;
        }
        const recorded = previous[source.path];
        if (recorded !== undefined && recorded !== source.contentHash) {
          deps.ui.warn(deps.t('instructions.doctorChanged', { path: source.path }));
        } else {
          deps.ui.success(deps.t('instructions.doctorOk', { path: source.path }));
        }
      }
      for (const path of Object.keys(previous)) {
        if (!sources.some((source) => source.path === path)) {
          problems += 1;
          deps.ui.error(deps.t('instructions.doctorMissingRecorded', { path }));
        }
      }

      // Record the current hashes as the new baseline.
      mkdirSync(join(repoRoot, EXCALIBUR_DIR, 'cache'), { recursive: true });
      const snapshot: Record<string, string> = {};
      for (const source of sources) {
        snapshot[source.path] = source.contentHash;
      }
      writeFileSync(lockPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

      if (problems === 0) {
        deps.ui.success(deps.t('instructions.doctorAllReachable'));
      }
    });
}
