import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_SAFETY_PRESET_ID,
  EXCALIBUR_DIR,
  SAFETY_PRESETS,
  createExtensionHost,
  getGitInfo,
  loadExcaliburConfig,
} from '@excalibur/core';
import { detectCommands } from '@excalibur/context-engine';
import { loadCliCredentials } from '@excalibur/enterprise-sync';
import { loadProvidersFile } from '@excalibur/model-gateway';
import { ExcaliburError } from '@excalibur/shared';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { CliDeps } from '../deps';
import { providersFilePath } from '../lib/context';
import { resolveNetworkPlan } from '../lib/network-proxy';

type CheckStatus = 'PASS' | 'WARN' | 'FAIL';

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `excalibur doctor` (ONB-9): environment and configuration diagnosis with
 * PASS/WARN/FAIL lines. Exit code 1 when any check FAILs.
 */
export function registerDoctorCommand(program: Command, deps: CliDeps): void {
  program
    .command('doctor')
    .description('diagnose the local Excalibur setup')
    .option('--json', 'machine-readable JSON output')
    .action(async (options: { json?: boolean }) => {
      const repoRoot = deps.cwd();
      const results: CheckResult[] = [];
      const add = (name: string, status: CheckStatus, detail: string): void => {
        results.push({ name, status, detail });
      };

      // Node version (engines ≥ 22).
      const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
      add(
        deps.t('doctor.check.nodeVersion'),
        major >= 22 ? 'PASS' : 'FAIL',
        `v${process.versions.node}${major >= 22 ? '' : deps.t('doctor.detail.nodeTooOld')}`,
      );

      // Git availability + repository detection.
      const gitVersion = spawnSync('git', ['--version'], { encoding: 'utf8' });
      const gitAvailable = gitVersion.status === 0;
      add(
        deps.t('doctor.check.gitAvailable'),
        gitAvailable ? 'PASS' : 'FAIL',
        gitAvailable ? gitVersion.stdout.trim() : deps.t('doctor.detail.gitNotFound'),
      );
      if (gitAvailable) {
        const info = getGitInfo(repoRoot);
        add(
          deps.t('doctor.check.gitRepository'),
          info.isRepo ? 'PASS' : 'WARN',
          info.isRepo
            ? deps.t('doctor.detail.gitBranch', { branch: info.branch ?? '(detached)' })
            : deps.t('doctor.detail.gitNotRepo'),
        );
      }

      // .excalibur/ + config validity.
      const excaliburDir = join(repoRoot, EXCALIBUR_DIR);
      if (!existsSync(excaliburDir)) {
        add('.excalibur/', 'WARN', deps.t('doctor.detail.excaliburNotInit'));
      } else {
        try {
          const loaded = loadExcaliburConfig(repoRoot);
          add(
            '.excalibur/config.yaml',
            'PASS',
            loaded.source === 'file'
              ? deps.t('doctor.detail.configValid')
              : deps.t('doctor.detail.configMissing'),
          );
          const presetId = loaded.config.safety?.preset ?? DEFAULT_SAFETY_PRESET_ID;
          add(
            deps.t('doctor.check.safetyPreset'),
            SAFETY_PRESETS[presetId] !== undefined ? 'PASS' : 'WARN',
            SAFETY_PRESETS[presetId] !== undefined
              ? deps.t('doctor.detail.presetActive', { presetId })
              : deps.t('doctor.detail.presetUnknown', {
                  presetId,
                  fallback: DEFAULT_SAFETY_PRESET_ID,
                }),
          );

          // Instruction sources reachable.
          const sources = loaded.config.instructions?.sources ?? [];
          const missing = sources.filter((source) => {
            if (source.path.startsWith('~/')) {
              return !existsSync(join(deps.homeDir(), source.path.slice(2)));
            }
            return !existsSync(join(repoRoot, source.path.replace(/^\.\//, '')));
          });
          add(
            deps.t('doctor.check.instructionSources'),
            missing.length === 0 ? 'PASS' : 'WARN',
            missing.length === 0
              ? deps.t('doctor.detail.sourcesReachable', { count: sources.length })
              : deps.t('doctor.detail.sourcesMissing', {
                  paths: missing.map((source) => source.path).join(', '),
                }),
          );

          // Network transport (corporate proxy + custom CA, P0.2). Pure resolve
          // (no global side effect): report what egress will honor.
          const netPlan = resolveNetworkPlan(loaded.config.network, process.env);
          add(
            'Network transport (proxy/CA)',
            netPlan.insecure ? 'WARN' : 'PASS',
            netPlan.notes.length > 0
              ? netPlan.notes.join('; ')
              : 'direct (no proxy or custom CA configured)',
          );
        } catch (error) {
          add('.excalibur/config.yaml', 'FAIL', describe(error));
        }
      }

      // Providers config + API key env presence.
      const providersPath = providersFilePath(repoRoot);
      if (!existsSync(providersPath)) {
        add(
          deps.t('doctor.check.modelProviders'),
          'WARN',
          deps.t('doctor.detail.providersMissing'),
        );
      } else {
        try {
          const providers = loadProvidersFile(providersPath);
          add(
            deps.t('doctor.check.modelProviders'),
            'PASS',
            deps.t('doctor.detail.providersValid'),
          );
          for (const [name, config] of Object.entries(providers.providers)) {
            if (name === 'default' || typeof config === 'string') {
              continue;
            }
            const keyEnv = (config as { apiKeyEnv?: string }).apiKeyEnv;
            if (keyEnv !== undefined) {
              const present = typeof deps.env[keyEnv] === 'string' && deps.env[keyEnv] !== '';
              add(
                deps.t('doctor.check.apiKeyEnv', { name }),
                present ? 'PASS' : 'WARN',
                present
                  ? deps.t('doctor.detail.keyEnvSet', { keyEnv })
                  : deps.t('doctor.detail.keyEnvUnset', { keyEnv }),
              );
            }
          }
        } catch (error) {
          add(deps.t('doctor.check.modelProviders'), 'FAIL', describe(error));
        }
      }

      // Detected commands.
      const commands = await detectCommands(repoRoot);
      add(
        deps.t('doctor.check.detectedCommands'),
        commands.test !== undefined ? 'PASS' : 'WARN',
        Object.entries(commands)
          .map(([key, value]) => `${key}: ${value}`)
          .join(' / ') || deps.t('doctor.detail.commandsNone'),
      );

      // Extension host: catalogs + load errors.
      try {
        const registry = await createExtensionHost(repoRoot);
        const workflows = registry.contributions.workflows().length;
        const methodologies = registry.contributions.methodologies().length;
        add(
          deps.t('doctor.check.workflowCatalog'),
          workflows > 0 ? 'PASS' : 'FAIL',
          deps.t('doctor.detail.workflowCounts', { workflows, methodologies }),
        );
        const failed = registry.extensions().filter((extension) => extension.status === 'error');
        // Unbuilt local scaffolds (missing entrypoint) are expected until the
        // user compiles them: WARN here, FAIL only on real load errors.
        const unbuilt = failed.filter((extension) =>
          (extension.error ?? '').includes('entrypoint'),
        );
        const broken = failed.filter(
          (extension) => !(extension.error ?? '').includes('entrypoint'),
        );
        add(
          deps.t('doctor.check.extensions'),
          broken.length > 0 ? 'FAIL' : unbuilt.length > 0 ? 'WARN' : 'PASS',
          failed.length === 0
            ? deps.t('doctor.detail.extensionsLoaded', { count: registry.extensions().length })
            : failed
                .map(
                  (extension) =>
                    `${extension.manifest.id}: ${extension.error ?? deps.t('doctor.detail.loadError')}`,
                )
                .join('; '),
        );
        const warnings = registry.contributions.warnings();
        if (warnings.length > 0) {
          add(deps.t('doctor.check.extensionWarnings'), 'WARN', warnings.join('; '));
        }
      } catch (error) {
        add(deps.t('doctor.check.extensions'), 'FAIL', describe(error));
      }

      // Enterprise credentials (optional).
      const credentials = loadCliCredentials({
        baseDir: deps.homeDir(),
        env: deps.env as Record<string, string | undefined>,
      });
      add(
        deps.t('doctor.check.enterpriseCredentials'),
        'PASS',
        credentials !== null
          ? deps.t('doctor.detail.credentialsConnected', { baseUrl: credentials.baseUrl })
          : deps.t('doctor.detail.credentialsNone'),
      );

      if (options.json === true) {
        deps.ui.json(results);
      } else {
        for (const result of results) {
          const label =
            result.status === 'PASS'
              ? pc.green('PASS')
              : result.status === 'WARN'
                ? pc.yellow('WARN')
                : pc.red('FAIL');
          deps.ui.write(`${label}  ${result.name.padEnd(26)} ${pc.dim(result.detail)}`);
        }
      }

      const failed = results.filter((result) => result.status === 'FAIL');
      if (failed.length > 0) {
        // Runtime error → exit code 1 (Build Contract: doctor exits 1 on FAIL).
        throw new ExcaliburError(
          deps.t('doctor.error.failed', { count: failed.length }),
          'doctor_failed',
        );
      }
    });
}
