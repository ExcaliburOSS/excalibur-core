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

      deps.ui.heading('Extensions:');
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
      deps.ui.heading('Contributions:');
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
          deps.ui.success(
            `${report.checked.length} file(s) validated — everything looks good.`,
          );
        }
      }
      if (report.errors.length > 0) {
        throw new CliUsageError(
          `extensions validate found ${report.errors.length} invalid file(s).`,
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
            issues.push('missing entrypoint declaration');
          } else if (!existsSync(join(extension.dir, entrypoint))) {
            issues.push(`entrypoint ${entrypoint} not built yet — run its build first`);
          }
        }
        issues.push(...validatePermissions(extension.manifest));
        if (issues.length > 0) {
          problems += issues.length;
          for (const issue of issues) {
            deps.ui.warn(`${extension.manifest.id}: ${issue}`);
          }
        } else {
          deps.ui.success(`${extension.manifest.id} (${extension.source}) loaded cleanly`);
        }
      }
      for (const warning of registry.contributions.warnings()) {
        deps.ui.warn(warning);
      }
      if (registry.extensions().some((extension) => extension.status === 'error')) {
        throw new ExcaliburError('extensions doctor found load errors.', 'extensions_doctor_failed');
      }
      if (problems === 0) {
        deps.ui.success('All extensions are healthy.');
      }
    });

  extensions
    .command('enable')
    .description('enable an extension id in .excalibur/extensions.yaml')
    .argument('<id>', 'extension id')
    .action((id: string) => {
      setExtensionEnabled(deps.cwd(), id, true);
      deps.ui.success(`Extension "${id}" enabled in ${EXCALIBUR_DIR}/extensions.yaml.`);
    });

  extensions
    .command('disable')
    .description('disable an extension id in .excalibur/extensions.yaml')
    .argument('<id>', 'extension id')
    .action((id: string) => {
      setExtensionEnabled(deps.cwd(), id, false);
      deps.ui.success(`Extension "${id}" disabled in ${EXCALIBUR_DIR}/extensions.yaml.`);
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
        deps.ui.warn(
          `"${sourcePath}" is not a local directory. Installing extensions from npm arrives in M8 — ` +
            'until then, pass a local folder containing excalibur.extension.yaml.',
        );
        return;
      }
      const manifestPath = join(source, 'excalibur.extension.yaml');
      if (!existsSync(manifestPath)) {
        throw new CliUsageError(`${sourcePath} has no excalibur.extension.yaml manifest.`);
      }
      const manifest = loadManifest(manifestPath);
      for (const warning of validatePermissions(manifest)) {
        deps.ui.warn(warning);
      }
      const target = join(repoRoot, EXCALIBUR_DIR, 'extensions', manifest.id);
      if (existsSync(target)) {
        throw new CliUsageError(
          `Extension "${manifest.id}" is already installed at ${target}. Remove it first to reinstall.`,
        );
      }
      const confirmed = await deps.ui.confirm(
        `Install extension "${manifest.id}" (${manifest.kind}) into ${EXCALIBUR_DIR}/extensions/?`,
        { yes: options.yes, defaultYes: true },
      );
      if (!confirmed) {
        deps.ui.info('Install cancelled.');
        return;
      }
      mkdirSync(join(repoRoot, EXCALIBUR_DIR, 'extensions'), { recursive: true });
      cpSync(source, target, { recursive: true });
      deps.ui.success(`Installed "${manifest.id}" → ${target}`);
      deps.ui.info('Run `excalibur extensions validate` to verify it.');
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
      deps.ui.success(`Scaffolded ${result.kind} extension "${name}" → ${result.dir}`);
      for (const file of result.files) {
        deps.ui.write(`  + ${file}`);
      }
      if (result.kind === 'programmatic') {
        deps.ui.info(
          'Programmatic extensions load their COMPILED entrypoint: run `npm install && npm run build` inside the folder first.',
        );
      }
      deps.ui.info('Validate with: excalibur extensions validate');
    });
}
