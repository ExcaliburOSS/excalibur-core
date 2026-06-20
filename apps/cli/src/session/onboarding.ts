import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXCALIBUR_DIR, applyInitPlan, generateInitPlan } from '@excalibur/core';
import type { RepoAnalysis } from '@excalibur/context-engine';
import type { ProvidersFileConfig } from '@excalibur/model-gateway';
import type { CliDeps } from '../deps';
import { providersFilePath, safetyLine } from '../lib/context';
import { promptProviderSetup } from '../lib/provider-setup';

/**
 * Zero-config onboarding for the interactive shell (the `core-onboarding-ux`
 * principle + onboarding-core.md): a developer must NEVER have to discover
 * `excalibur init` or `excalibur models setup`. On the first `excalibur` run in
 * a repo — when `.excalibur/` is absent OR no model provider is configured — the
 * m-shell automatically runs the model wizard (API key + subscription, with the
 * one-key good+fast auto-pair) and writes a minimal `.excalibur/`, then drops
 * the user straight into the shell. `init` stays an optional power-user command.
 *
 * Gentle consent (never silently writes files): a single confirm gates the
 * setup; declining drops into the shell on the offline mock with no dead end.
 * Only ever runs on a real interactive TTY — pipes/CI/tests keep the mock and
 * write nothing.
 *
 * @returns `true` when it wrote `.excalibur/` (so the caller reloads config +
 * gateway to reflect the freshly-configured model), `false` otherwise.
 */
export async function maybeAutoOnboard(
  deps: CliDeps,
  repoRoot: string,
  analysis: RepoAnalysis,
): Promise<boolean> {
  if (!deps.ui.isInteractive() || !deps.ui.isOutputTty()) {
    return false;
  }
  const dirExists = existsSync(join(repoRoot, EXCALIBUR_DIR));
  const providerConfigured = existsSync(providersFilePath(repoRoot));
  if (dirExists && providerConfigured) {
    return false; // already set up — nothing to onboard
  }

  // Gentle consent — never silently write files.
  deps.ui.write();
  deps.ui.heading(deps.t('onboarding.title'));
  deps.ui.info(deps.t('onboarding.intro'));
  const proceed = await deps.ui.confirm(deps.t('onboarding.confirm'), { defaultYes: true });
  if (!proceed) {
    deps.ui.info(deps.t('onboarding.skipped'));
    deps.ui.write();
    return false;
  }

  // The model wizard (API key + subscription rails, one-key auto-pair) — only
  // when no provider is configured yet. "Configure later" returns null → no
  // dead end (the shell runs on the offline mock until `models setup`).
  let providers: ProvidersFileConfig | undefined;
  if (!providerConfigured) {
    const chosen = await promptProviderSetup(deps, { yes: false });
    if (chosen !== null) {
      providers = chosen;
    }
  }

  // Write a minimal `.excalibur/` (config + instructions + extensions [+ the
  // chosen providers.yaml]). `overwrite: false` only writes missing files, so
  // re-onboarding to add a provider leaves any existing config untouched.
  const plan = generateInitPlan(analysis, {
    mode: 'minimal',
    ...(providers !== undefined ? { providers } : {}),
  });
  const result = applyInitPlan(repoRoot, plan, { overwrite: false });
  if (result.written.length > 0) {
    deps.ui.write();
    deps.ui.heading(deps.t('onboarding.created'));
    for (const relPath of result.written) {
      deps.ui.write(`  + ${relPath}`);
    }
  }
  if (providers === undefined && !providerConfigured) {
    deps.ui.info(deps.t('onboarding.noProvider'));
  }
  deps.ui.write(safetyLine(deps.t, {}));
  deps.ui.write();
  return result.written.length > 0;
}
