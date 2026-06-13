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
        'node version',
        major >= 22 ? 'PASS' : 'FAIL',
        `v${process.versions.node}${major >= 22 ? '' : ' — Excalibur requires Node ≥ 22'}`,
      );

      // Git availability + repository detection.
      const gitVersion = spawnSync('git', ['--version'], { encoding: 'utf8' });
      const gitAvailable = gitVersion.status === 0;
      add('git available', gitAvailable ? 'PASS' : 'FAIL', gitAvailable ? gitVersion.stdout.trim() : 'git not found on PATH');
      if (gitAvailable) {
        const info = getGitInfo(repoRoot);
        add(
          'git repository',
          info.isRepo ? 'PASS' : 'WARN',
          info.isRepo ? `branch: ${info.branch ?? '(detached)'}` : 'not a git repository — diffs and branches unavailable',
        );
      }

      // .excalibur/ + config validity.
      const excaliburDir = join(repoRoot, EXCALIBUR_DIR);
      if (!existsSync(excaliburDir)) {
        add('.excalibur/', 'WARN', 'not initialized — run `excalibur init` (defaults still work)');
      } else {
        try {
          const loaded = loadExcaliburConfig(repoRoot);
          add('.excalibur/config.yaml', 'PASS', loaded.source === 'file' ? 'valid' : 'missing — defaults active');
          const presetId = loaded.config.safety?.preset ?? DEFAULT_SAFETY_PRESET_ID;
          add(
            'safety preset',
            SAFETY_PRESETS[presetId] !== undefined ? 'PASS' : 'WARN',
            SAFETY_PRESETS[presetId] !== undefined
              ? `${presetId} active`
              : `unknown preset "${presetId}" — falling back to ${DEFAULT_SAFETY_PRESET_ID}`,
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
            'instruction sources',
            missing.length === 0 ? 'PASS' : 'WARN',
            missing.length === 0
              ? `${sources.length} configured, all reachable`
              : `missing: ${missing.map((source) => source.path).join(', ')}`,
          );
        } catch (error) {
          add('.excalibur/config.yaml', 'FAIL', describe(error));
        }
      }

      // Providers config + API key env presence.
      const providersPath = providersFilePath(repoRoot);
      if (!existsSync(providersPath)) {
        add('model providers', 'WARN', 'no providers.yaml — using the built-in mock (run `excalibur models setup`)');
      } else {
        try {
          const providers = loadProvidersFile(providersPath);
          add('model providers', 'PASS', 'providers.yaml valid');
          for (const [name, config] of Object.entries(providers.providers)) {
            if (name === 'default' || typeof config === 'string') {
              continue;
            }
            const keyEnv = (config as { apiKeyEnv?: string }).apiKeyEnv;
            if (keyEnv !== undefined) {
              const present = typeof deps.env[keyEnv] === 'string' && deps.env[keyEnv] !== '';
              add(
                `api key env (${name})`,
                present ? 'PASS' : 'WARN',
                present ? `${keyEnv} is set` : `${keyEnv} is not set`,
              );
            }
          }
        } catch (error) {
          add('model providers', 'FAIL', describe(error));
        }
      }

      // Detected commands.
      const commands = await detectCommands(repoRoot);
      add(
        'detected commands',
        commands.test !== undefined ? 'PASS' : 'WARN',
        Object.entries(commands)
          .map(([key, value]) => `${key}: ${value}`)
          .join(' / ') || 'none detected — agents cannot verify changes',
      );

      // Extension host: catalogs + load errors.
      try {
        const registry = await createExtensionHost(repoRoot);
        const workflows = registry.contributions.workflows().length;
        const methodologies = registry.contributions.methodologies().length;
        add('workflow catalog', workflows > 0 ? 'PASS' : 'FAIL', `${workflows} workflows, ${methodologies} methodologies`);
        const failed = registry.extensions().filter((extension) => extension.status === 'error');
        // Unbuilt local scaffolds (missing entrypoint) are expected until the
        // user compiles them: WARN here, FAIL only on real load errors.
        const unbuilt = failed.filter((extension) => (extension.error ?? '').includes('entrypoint'));
        const broken = failed.filter((extension) => !(extension.error ?? '').includes('entrypoint'));
        add(
          'extensions',
          broken.length > 0 ? 'FAIL' : unbuilt.length > 0 ? 'WARN' : 'PASS',
          failed.length === 0
            ? `${registry.extensions().length} loaded`
            : failed.map((extension) => `${extension.manifest.id}: ${extension.error ?? 'load error'}`).join('; '),
        );
        const warnings = registry.contributions.warnings();
        if (warnings.length > 0) {
          add('extension warnings', 'WARN', warnings.join('; '));
        }
      } catch (error) {
        add('extensions', 'FAIL', describe(error));
      }

      // Enterprise credentials (optional).
      const credentials = loadCliCredentials({
        baseDir: deps.homeDir(),
        env: deps.env as Record<string, string | undefined>,
      });
      add(
        'enterprise credentials',
        'PASS',
        credentials !== null ? `connected to ${credentials.baseUrl}` : 'not configured (optional)',
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
        throw new ExcaliburError(`doctor found ${failed.length} failing check(s).`, 'doctor_failed');
      }
    });
}
