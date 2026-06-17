import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { isCommandOnPath } from '@excalibur/agent-runtime';
import type { ProviderConfig, ProvidersFileConfig } from '@excalibur/model-gateway';
import type { CliDeps } from '../deps';
import { providersFilePath } from './context';
import { PROVIDER_CATALOG, type ProviderCatalogEntry } from './model-catalog';

/**
 * Model provider onboarding (onboarding spec §4), shared by `excalibur init` and
 * `excalibur models setup`. Providers store the NAME of an API key environment
 * variable — never a key value.
 *
 * Flow: pick a provider, then (for providers with a subscription) choose how you
 * pay — SUBSCRIPTION first (the individual-dev default), API key second (the
 * enterprise default). The API-key rail auto-configures a curated good + fast
 * model pair from one key (see {@link PROVIDER_CATALOG}); the subscription rail
 * uses a sanctioned subscription key (MiniMax/Kimi) or drives the vendor's own
 * CLI — Excalibur never reimplements/replays subscription OAuth. Free local
 * Ollama and a keyless self-hosted/own-infra endpoint (vLLM/TGI/Qwen) are also
 * covered; the mock is offline/tests only (never a runtime fallback). Excalibur
 * never hosts or pays for a model — every path is the user's own key/account or
 * local endpoint.
 */

const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_LOOKING_PATTERN = /^(sk-|ghp_|gho_|ghs_|xox|AKIA)/;

async function askEnvVarName(deps: CliDeps, defaultName: string, yes: boolean): Promise<string> {
  if (!yes && (deps.env[defaultName] ?? '').length > 0) {
    deps.ui.info(deps.t('provider-setup.detected_env', { defaultName }));
  }
  for (;;) {
    const answer = await deps.ui.ask(
      deps.t('provider-setup.ask_env_var_name', { defaultName }),
      { yes, defaultAnswer: defaultName },
    );
    if (SECRET_LOOKING_PATTERN.test(answer)) {
      deps.ui.warn(deps.t('provider-setup.looks_like_key_value'));
      continue;
    }
    if (!ENV_VAR_NAME_PATTERN.test(answer)) {
      deps.ui.warn(deps.t('provider-setup.env_var_format'));
      if (yes || !deps.ui.isInteractive()) {
        return defaultName;
      }
      continue;
    }
    return answer;
  }
}

/** Post-save guidance: the provider runs once its API key env var is set. */
function announceSaved(deps: CliDeps, apiKeyEnv: string): void {
  if ((deps.env[apiKeyEnv] ?? '').length > 0) {
    deps.ui.info(deps.t('provider-setup.saved_env_set', { apiKeyEnv }));
    return;
  }
  deps.ui.info(deps.t('provider-setup.saved_env_unset', { apiKeyEnv }));
}

/** A single-provider config — no bundled mock (the mock is never a fallback). */
function single(name: string, config: ProviderConfig): ProvidersFileConfig {
  return {
    providers: { default: name, [name]: config } as ProvidersFileConfig['providers'],
  };
}

const MOCK_ONLY: ProvidersFileConfig = single('mock', { type: 'mock' });

/**
 * Asks for an API-key ENV VAR NAME, allowing BLANK → no key (for a self-hosted /
 * own-infra endpoint that needs no auth). Returns the name, or undefined.
 */
async function askEnvVarNameOptional(
  deps: CliDeps,
  suggestion: string,
): Promise<string | undefined> {
  if ((deps.env[suggestion] ?? '').length > 0) {
    deps.ui.info(deps.t('provider-setup.detected_env_optional', { suggestion }));
  }
  const answer = (
    await deps.ui.ask(
      deps.t('provider-setup.ask_env_var_optional', { suggestion }),
      { defaultAnswer: '' },
    )
  ).trim();
  if (answer.length === 0) {
    return undefined;
  }
  if (SECRET_LOOKING_PATTERN.test(answer)) {
    deps.ui.warn(deps.t('provider-setup.looks_like_key_value_optional'));
    return undefined;
  }
  return ENV_VAR_NAME_PATTERN.test(answer) ? answer : suggestion;
}

/**
 * A good+fast PAIR config from one provider key: `default` → the good (coding)
 * model, `cheap` → the fast model (ghost-text + compaction), both sharing the
 * same API key env var. The fast provider carries the catalog's low-latency
 * `extraBody` (reasoning-off) so the `cheap` role stays snappy when consumed.
 */
function pairConfig(entry: ProviderCatalogEntry, apiKeyEnv: string): ProvidersFileConfig {
  const pair = entry.pair;
  if (pair === undefined) {
    return single(entry.key, { type: entry.type, apiKeyEnv }); // unreachable: callers guard
  }
  const fastName = `${entry.key}-fast`;
  const make = (model: string, extraBody?: Record<string, unknown>): ProviderConfig => {
    const config: ProviderConfig = { type: entry.type, apiKeyEnv, model };
    if (entry.baseUrl !== undefined) {
      config.baseUrl = entry.baseUrl;
    }
    if (extraBody !== undefined) {
      config.extraBody = extraBody;
    }
    return config;
  };
  const good = make(pair.good);
  if (entry.contextWindow !== undefined) {
    good.contextWindow = entry.contextWindow;
  }
  return {
    providers: {
      default: entry.key,
      cheap: fastName,
      [entry.key]: good,
      [fastName]: make(pair.fast, pair.fastExtraBody),
    } as ProvidersFileConfig['providers'],
  };
}

/** Dim hint for the "Subscription" option, per the provider's sanctioned path. */
function subscriptionHint(deps: CliDeps, entry: ProviderCatalogEntry): string {
  const sub = entry.subscription;
  if (sub === undefined) {
    return '';
  }
  if (sub.kind === 'subscription-key') {
    return deps.t('provider-setup.hint_subscription_key');
  }
  return sub.risk === 'prohibited'
    ? deps.t('provider-setup.hint_cli_prohibited')
    : deps.t('provider-setup.hint_cli_own_risk');
}

/** The API-key (BYOK) rail: prompt the key env var, auto-configure good+fast, show it. */
async function setupApiKeyRail(
  deps: CliDeps,
  entry: ProviderCatalogEntry,
): Promise<ProvidersFileConfig> {
  const apiKeyEnv = await askEnvVarName(deps, entry.apiKeyEnv, false);
  if (entry.pair !== undefined) {
    deps.ui.info(
      deps.t('provider-setup.auto_configured', {
        label: entry.label,
        good: entry.pair.good,
        fast: entry.pair.fast,
        apiKeyEnv,
      }),
    );
    announceSaved(deps, apiKeyEnv);
    return pairConfig(entry, apiKeyEnv);
  }
  const model = (
    await deps.ui.ask(deps.t('provider-setup.ask_model', { label: entry.label }), {
      defaultAnswer: '',
    })
  ).trim();
  announceSaved(deps, apiKeyEnv);
  const config: ProviderConfig = { type: entry.type, apiKeyEnv };
  if (entry.baseUrl !== undefined) {
    config.baseUrl = entry.baseUrl;
  }
  if (model.length > 0) {
    config.model = model;
  }
  return single(entry.key, config);
}

/**
 * The subscription branch for one provider. A SANCTIONED subscription-backed API
 * key (MiniMax/Kimi) is clean BYOK on the subscription quota. Otherwise the
 * subscription is reachable only through the vendor's own CLI: Excalibur NEVER
 * reimplements/replays subscription OAuth (Anthropic/Google/Copilot prohibit it,
 * OpenAI/xAI are gray) — the official-CLI passthrough adapter drives the vendor's
 * binary later; for now we explain that, then nudge to the API-key rail.
 */
async function setupSubscription(
  deps: CliDeps,
  entry: ProviderCatalogEntry,
): Promise<ProvidersFileConfig | null> {
  const sub = entry.subscription;
  if (sub === undefined) {
    return setupApiKeyRail(deps, entry);
  }
  if (sub.kind === 'subscription-key' && sub.keyConfig !== undefined) {
    deps.ui.info(deps.t('provider-setup.subscription_key_native', { label: entry.label }));
    const apiKeyEnv = await askEnvVarName(deps, sub.keyConfig.apiKeyEnv, false);
    announceSaved(deps, apiKeyEnv);
    return single(entry.key, {
      type: entry.type,
      baseUrl: sub.keyConfig.baseUrl,
      apiKeyEnv,
      model: sub.keyConfig.model,
    });
  }
  if (sub.disclaimer !== undefined) {
    deps.ui.warn(sub.disclaimer);
  }
  if (sub.cli !== undefined) {
    deps.ui.info(
      deps.t('provider-setup.cli_passthrough', {
        command: sub.cli.command,
        loginHint: sub.cli.loginHint,
      }),
    );
  }
  const useKey = await deps.ui.confirm(
    deps.t('provider-setup.confirm_api_key_instead', { label: entry.label }),
    {
      defaultYes: true,
    },
  );
  if (useKey) {
    return setupApiKeyRail(deps, entry);
  }
  deps.ui.info(deps.t('provider-setup.no_problem_later', { label: entry.label }));
  return null;
}

type ProviderChoice =
  | { kind: 'catalog'; entry: ProviderCatalogEntry }
  | { kind: 'ollama' }
  | { kind: 'self-hosted' }
  | { kind: 'mock' }
  | { kind: 'later' };

/**
 * The comfortable model-onboarding chooser (OSS, USER level — `excalibur init` /
 * `models setup`). Pick a provider, then — for providers with a subscription —
 * choose how you pay, SUBSCRIPTION FIRST (most individual devs pay a subscription;
 * API key is the second option and the enterprise default). The API-key rail
 * AUTO-CONFIGURES a curated good + fast model pair from one key; the subscription
 * rail uses a sanctioned subscription key (MiniMax/Kimi) or drives the vendor's
 * official CLI. Also covers free local Ollama and a keyless self-hosted/own-infra
 * endpoint (vLLM/TGI/Qwen), plus the offline mock for tests. Excalibur never
 * hosts/pays for a model — everything here is the user's own key/account or local
 * endpoint. Returns the config to write, or null for "Configure later";
 * `--yes`/non-interactive writes the explicit test mock. (Org/team-level central
 * provisioning lives in Excalibur Enterprise — admins configure once, users inherit.)
 */
export async function promptProviderSetup(
  deps: CliDeps,
  options: { yes: boolean },
): Promise<ProvidersFileConfig | null> {
  if (options.yes || !deps.ui.isInteractive()) {
    return MOCK_ONLY; // tests/CI/offline — no key to prompt for
  }

  const ollamaDetected = isCommandOnPath('ollama', deps.env);
  const choices: ProviderChoice[] = [
    ...PROVIDER_CATALOG.map((entry): ProviderChoice => ({ kind: 'catalog', entry })),
    { kind: 'ollama' },
    { kind: 'self-hosted' },
    { kind: 'mock' },
    { kind: 'later' },
  ];
  const labels = choices.map((choice) => {
    switch (choice.kind) {
      case 'catalog':
        return { label: choice.entry.label, hint: choice.entry.hint };
      case 'ollama':
        return {
          label: deps.t('provider-setup.opt_ollama'),
          hint: ollamaDetected
            ? deps.t('provider-setup.hint_ollama_detected')
            : deps.t('provider-setup.hint_ollama_install'),
        };
      case 'self-hosted':
        return {
          label: deps.t('provider-setup.opt_self_hosted'),
          hint: deps.t('provider-setup.hint_self_hosted'),
        };
      case 'mock':
        return { label: deps.t('provider-setup.opt_mock'), hint: deps.t('provider-setup.hint_mock') };
      case 'later':
        return { label: deps.t('provider-setup.opt_later') };
    }
  });

  const index = await deps.ui.select(
    deps.t('provider-setup.select_provider'),
    labels,
    { yes: false, defaultIndex: 0 },
  );
  const choice = choices[index] ?? { kind: 'later' };

  switch (choice.kind) {
    case 'catalog': {
      const entry = choice.entry;
      if (entry.subscription !== undefined) {
        // Subscription-first ordering (OSS individual devs mostly pay a subscription).
        const how = await deps.ui.select(
          deps.t('provider-setup.how_do_you_use', { label: entry.label }),
          [
            { label: deps.t('provider-setup.opt_subscription'), hint: subscriptionHint(deps, entry) },
            {
              label: deps.t('provider-setup.opt_api_key'),
              hint: deps.t('provider-setup.hint_api_key'),
            },
          ],
          { yes: false, defaultIndex: 0 },
        );
        return how === 0 ? setupSubscription(deps, entry) : setupApiKeyRail(deps, entry);
      }
      return setupApiKeyRail(deps, entry);
    }
    case 'ollama': {
      const model = await deps.ui.ask(deps.t('provider-setup.ask_ollama_model'), {
        defaultAnswer: 'llama3',
      });
      deps.ui.info(deps.t('provider-setup.saved_ollama'));
      return single('ollama', { type: 'ollama', baseUrl: 'http://localhost:11434', model });
    }
    case 'self-hosted': {
      // vLLM, TGI, SGLang, an internal Qwen/Llama gateway — any OpenAI-compatible
      // endpoint. Auth optional (keyless). This is the main path for Qwen run on
      // your own / private infra.
      const baseUrl = await deps.ui.ask(deps.t('provider-setup.ask_endpoint_url'), {
        defaultAnswer: 'http://localhost:8000/v1',
      });
      const model = await deps.ui.ask(deps.t('provider-setup.ask_endpoint_model'), {
        defaultAnswer: 'Qwen/Qwen2.5-Coder-32B-Instruct',
      });
      const apiKeyEnv = await askEnvVarNameOptional(deps, 'LLM_API_KEY');
      deps.ui.info(
        apiKeyEnv !== undefined
          ? deps.t('provider-setup.saved_self_hosted_auth', { baseUrl, apiKeyEnv })
          : deps.t('provider-setup.saved_self_hosted_keyless', { baseUrl }),
      );
      const config: ProviderConfig = { type: 'openai-compatible', baseUrl, model };
      if (apiKeyEnv !== undefined) {
        config.apiKeyEnv = apiKeyEnv;
      }
      return single('self-hosted', config);
    }
    case 'mock':
      return MOCK_ONLY;
    case 'later':
    default:
      return null;
  }
}

/** Writes `.excalibur/models/providers.yaml` and returns its absolute path. */
export function writeProvidersFile(repoRoot: string, config: ProvidersFileConfig): string {
  const filePath = providersFilePath(repoRoot);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, stringifyYaml(config), 'utf8');
  return filePath;
}
