import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EXCALIBUR_DIR, createExtensionHost } from '@excalibur/core';
import { loadManifest, validatePermissions } from '@excalibur/extension-runtime';
import { ExcaliburError } from '@excalibur/shared';
import type { Command } from 'commander';
import pc from 'picocolors';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import { setExtensionEnabled } from '../lib/config-file';
import { SCAFFOLD_TYPES, scaffoldExtension } from '../lib/scaffold';
import { validateRepoExtensions } from '../lib/validate-extensions';

/**
 * `excalibur extensions ...` (extensions spec §9): list, validate, doctor,
 * enable/disable, install (local paths; npm arrives in M8) and create
 * (scaffolds that pass `extensions validate`).
 */
export function registerExtensionsCommand(program: Command, deps: CliDeps): void {
  const extensions = program
    .command('extensions')
    .description('manage Excalibur extensions (declarative and programmatic)');

  extensions
    .command('list')
    .description('list loaded extensions and their contributions')
    .option('--json', 'machine-readable JSON output')
    .action(async (options: { json?: boolean }) => {
      const registry = await createExtensionHost(deps.cwd());
      const loaded = registry.extensions();
      const contributions = registry.contributions.list();
      if (options.json === true) {
        deps.ui.json({
          extensions: loaded.map((extension) => ({
            id: extension.manifest.id,
            name: extension.manifest.name,
            version: extension.manifest.version,
            kind: extension.manifest.kind,
            source: extension.source,
            status: extension.status,
            ...(extension.error !== undefined ? { error: extension.error } : {}),
          })),
          contributions: contributions.map((contribution) => ({
            kind: contribution.kind,
            id: contribution.id,
            extensionId: contribution.extensionId,
            source: contribution.source,
          })),
          warnings: registry.contributions.warnings(),
        });
        return;
      }

      deps.ui.heading(deps.t('extensions.list_extensions_heading'));
      deps.ui.table(
        ['ID', 'NAME', 'VERSION', 'KIND', 'SOURCE', 'STATUS'],
        loaded.map((extension) => [
          extension.manifest.id,
          extension.manifest.name,
          extension.manifest.version,
          extension.manifest.kind,
          extension.source,
          extension.status === 'error' ? pc.red('error') : extension.status,
        ]),
      );
      deps.ui.write();
      deps.ui.heading(deps.t('extensions.list_contributions_heading'));
      deps.ui.table(
        ['KIND', 'ID', 'EXTENSION', 'SOURCE'],
        contributions.map((contribution) => [
          contribution.kind,
          contribution.id,
          contribution.extensionId,
          contribution.source,
        ]),
      );
      for (const warning of registry.contributions.warnings()) {
        deps.ui.warn(warning);
      }
    });

  extensions
    .command('validate')
    .description('validate every manifest and declarative file in this repository')
    .option('--json', 'machine-readable JSON output')
    .action((options: { json?: boolean }) => {
      const report = validateRepoExtensions(deps.cwd());
      if (options.json === true) {
        deps.ui.json(report);
      } else {
        for (const warning of report.warnings) {
          deps.ui.warn(warning);
        }
        for (const issue of report.errors) {
          deps.ui.error(`${issue.file}: ${issue.message}`);
        }
        if (report.errors.length === 0) {
          deps.ui.success(deps.t('extensions.validate_ok', { count: report.checked.length }));
        }
      }
      if (report.errors.length > 0) {
        throw new CliUsageError(
          deps.t('extensions.validate_invalid', { count: report.errors.length }),
        );
      }
    });

  extensions
    .command('doctor')
    .description('diagnose extension load errors, missing entrypoints and permission warnings')
    .action(async () => {
      const repoRoot = deps.cwd();
      const registry = await createExtensionHost(repoRoot);
      let problems = 0;

      for (const extension of registry.extensions()) {
        if (extension.status === 'error') {
          problems += 1;
          deps.ui.error(`${extension.manifest.id}: ${extension.error ?? 'failed to load'}`);
          continue;
        }
        const issues: string[] = [];
        if (extension.manifest.kind !== 'declarative' && extension.dir !== null) {
          const entrypoint = extension.manifest.entrypoint;
          if (entrypoint === undefined) {
            issues.push(deps.t('extensions.doctor_missing_entrypoint'));
          } else if (!existsSync(join(extension.dir, entrypoint))) {
            issues.push(deps.t('extensions.doctor_entrypoint_not_built', { entrypoint }));
          }
        }
        issues.push(...validatePermissions(extension.manifest));
        if (issues.length > 0) {
          problems += issues.length;
          for (const issue of issues) {
            deps.ui.warn(deps.t('extensions.doctor_issue', { id: extension.manifest.id, issue }));
          }
        } else {
          deps.ui.success(
            deps.t('extensions.doctor_loaded_cleanly', {
              id: extension.manifest.id,
              source: extension.source,
            }),
          );
        }
      }
      for (const warning of registry.contributions.warnings()) {
        deps.ui.warn(warning);
      }
      if (registry.extensions().some((extension) => extension.status === 'error')) {
        throw new ExcaliburError(
          'extensions doctor found load errors.',
          'extensions_doctor_failed',
        );
      }
      if (problems === 0) {
        deps.ui.success(deps.t('extensions.doctor_all_healthy'));
      }
    });

  extensions
    .command('enable')
    .description('enable an extension id in .excalibur/extensions.yaml')
    .argument('<id>', 'extension id')
    .action((id: string) => {
      setExtensionEnabled(deps.cwd(), id, true);
      deps.ui.success(deps.t('extensions.enabled', { id, dir: EXCALIBUR_DIR }));
    });

  extensions
    .command('disable')
    .description('disable an extension id in .excalibur/extensions.yaml')
    .argument('<id>', 'extension id')
    .action((id: string) => {
      setExtensionEnabled(deps.cwd(), id, false);
      deps.ui.success(deps.t('extensions.disabled', { id, dir: EXCALIBUR_DIR }));
    });

  extensions
    .command('install')
    .description('install a local extension folder into .excalibur/extensions/')
    .argument('<path>', 'path to a local extension directory')
    .option('-y, --yes', 'install without prompting')
    .action(async (sourcePath: string, options: { yes?: boolean }) => {
      const repoRoot = deps.cwd();
      const source = resolve(repoRoot, sourcePath);
      if (!existsSync(source)) {
        // npm specs land in M8 — be honest instead of guessing.
        deps.ui.warn(deps.t('extensions.install_not_local_dir', { path: sourcePath }));
        return;
      }
      const manifestPath = join(source, 'excalibur.extension.yaml');
      if (!existsSync(manifestPath)) {
        throw new CliUsageError(deps.t('extensions.install_no_manifest', { path: sourcePath }));
      }
      const manifest = loadManifest(manifestPath);
      for (const warning of validatePermissions(manifest)) {
        deps.ui.warn(warning);
      }
      const target = join(repoRoot, EXCALIBUR_DIR, 'extensions', manifest.id);
      if (existsSync(target)) {
        throw new CliUsageError(
          deps.t('extensions.install_already_installed', { id: manifest.id, target }),
        );
      }
      const confirmed = await deps.ui.confirm(
        deps.t('extensions.install_confirm', {
          id: manifest.id,
          kind: manifest.kind,
          dir: EXCALIBUR_DIR,
        }),
        { yes: options.yes, defaultYes: true },
      );
      if (!confirmed) {
        deps.ui.info(deps.t('extensions.install_cancelled'));
        return;
      }
      mkdirSync(join(repoRoot, EXCALIBUR_DIR, 'extensions'), { recursive: true });
      cpSync(source, target, { recursive: true });
      deps.ui.success(deps.t('extensions.install_done', { id: manifest.id, target }));
      deps.ui.info(deps.t('extensions.install_validate_hint'));
    });

  extensions
    .command('create')
    .description(`scaffold a new extension (${SCAFFOLD_TYPES.join(', ')})`)
    .argument('<type>', 'extension type')
    .argument('<name>', 'extension name (lowercase, dashes)')
    .option('--dir <dir>', 'target directory (defaults to .excalibur/extensions/)')
    .action((type: string, name: string, options: { dir?: string }) => {
      const repoRoot = deps.cwd();
      const targetDir =
        options.dir !== undefined
          ? resolve(repoRoot, options.dir)
          : join(repoRoot, EXCALIBUR_DIR, 'extensions');
      const result = scaffoldExtension(targetDir, type, name);
      deps.ui.success(
        deps.t('extensions.create_scaffolded', { kind: result.kind, name, dir: result.dir }),
      );
      for (const file of result.files) {
        deps.ui.write(`  + ${file}`);
      }
      if (result.kind === 'programmatic') {
        deps.ui.info(deps.t('extensions.create_programmatic_hint'));
      }
      deps.ui.info(deps.t('extensions.create_validate_hint'));
    });
}
