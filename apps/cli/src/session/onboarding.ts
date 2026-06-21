import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pc from 'picocolors';
import { EXCALIBUR_DIR, applyInitPlan, generateInitPlan } from '@excalibur/core';
import type { RepoAnalysis } from '@excalibur/context-engine';
import type { ProvidersFileConfig } from '@excalibur/model-gateway';
import type { CliDeps } from '../deps';
import { providersFilePath, safetyLine } from '../lib/context';
import { runConnectionTest } from '../lib/connection-test';
import { promptProviderSetup } from '../lib/provider-setup';

/**
 * Zero-config onboarding for the interactive shell (the `core-onboarding-ux`
 * principle + onboarding-core.md): a developer must NEVER have to discover
 * `excalibur init` or `excalibur models setup`. On the first `excalibur` run in
 * a repo — when `.excalibur/` is absent OR no model provider is configured — the
 * m-shell automatically runs the model wizard (paste your API key, with the
 * one-key good+fast auto-pair) and writes a minimal `.excalibur/`, then drops
 * the user straight into the shell. `init` stays an optional power-user command.
 *
 * Zero friction (proactive directive): NO "set up now?" confirm and NO
 * "Configure later" escape — Excalibur is useless without a model, so the first
 * run goes straight into the model picker and always wires one up (the picker
 * still offers free local Ollama / self-hosted; Ctrl-C exits). The connection
 * check at the end runs directly too. Only ever runs on a real interactive TTY —
 * pipes/CI/tests keep the mock and write nothing.
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

  // Zero-friction first run (proactive directive): no "set up now?" gate — we go
  // straight into the model picker, narrating what we're doing (a blue ⚔ accent
  // ties it to the arthurian welcome; color is TTY-only). There's no corner case
  // where a stray "no" dead-ends setup, and no "Configure later" escape either:
  // Excalibur is useless without a model, so we always wire one up now (Ctrl-C
  // still exits). The picker offers free local Ollama / self-hosted for users
  // without a paid key.
  deps.ui.write();
  deps.ui.heading(`${pc.blueBright('⚔')}  ${deps.t('onboarding.title')}`);
  deps.ui.info(deps.t('onboarding.intro'));

  let providers: ProvidersFileConfig | undefined;
  if (!providerConfigured) {
    const chosen = await promptProviderSetup(deps, { yes: false, allowLater: false });
    if (chosen !== null) {
      providers = chosen;
    }
  }

  // Write a minimal `.excalibur/` (config + instructions + extensions [+ the
  // chosen providers.yaml]). `overwrite: false` only writes missing files, so
  // re-onboarding to add a provider leaves any existing config untouched.
  const plan = generateInitPlan(analysis, {
    mode: 'minimal',
    locale: deps.locale,
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

  // Close with a live connection check — run DIRECTLY, no prompt (proactive
  // directive). Only when a key is actually available (pasted now or already in
  // the env); a failure is shown as a warning that never blocks the shell.
  if (providers !== undefined) {
    const defaultName = providers.providers.default;
    const chosen = typeof defaultName === 'string' ? providers.providers[defaultName] : undefined;
    const keyEnv = chosen?.apiKeyEnv;
    const hasKey = keyEnv !== undefined && (process.env[keyEnv] ?? '').length > 0;
    if (chosen !== undefined && chosen.type !== 'mock' && hasKey) {
      try {
        await runConnectionTest(deps);
      } catch (error) {
        deps.ui.warn(error instanceof Error ? error.message : String(error));
      }
    }
  }

  deps.ui.write(safetyLine(deps.t, {}));
  deps.ui.write();
  return result.written.length > 0;
}
