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
    deps.ui.info(`Detected ${defaultName} in your environment — press Enter to use it.`);
  }
  for (;;) {
    const answer = await deps.ui.ask(
      `Name of the environment variable holding the API key (never the key itself) [${defaultName}]:`,
      { yes, defaultAnswer: defaultName },
    );
    if (SECRET_LOOKING_PATTERN.test(answer)) {
      deps.ui.warn(
        'That looks like an API key VALUE. Enter the NAME of the environment variable instead ' +
          '(for example OPENAI_API_KEY) — Excalibur never stores key values.',
      );
      continue;
    }
    if (!ENV_VAR_NAME_PATTERN.test(answer)) {
      deps.ui.warn('Environment variable names use uppercase letters, digits and underscores.');
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
    deps.ui.info(
      `Saved. ✓ ${apiKeyEnv} is already set in your environment — this provider is ready. ` +
        'Run `excalibur models test` to confirm the connection.',
    );
    return;
  }
  deps.ui.info(
    `Saved. Set ${apiKeyEnv} to your API key (Excalibur stores only the variable name), then run ` +
      '`excalibur models test` to confirm. With no key set, commands ask you to configure one — there is no mock fallback.',
  );
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
    deps.ui.info(
      `Detected ${suggestion} in your environment — type it to send a bearer token, or leave blank for a keyless endpoint.`,
    );
  }
  const answer = (
    await deps.ui.ask(
      `API key env var (leave blank if your endpoint needs no auth) [${suggestion} or blank]:`,
      { defaultAnswer: '' },
    )
  ).trim();
  if (answer.length === 0) {
    return undefined;
  }
  if (SECRET_LOOKING_PATTERN.test(answer)) {
    deps.ui.warn(
      'That looks like a key VALUE — enter the NAME of the env var (or blank). Using blank.',
    );
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
function subscriptionHint(entry: ProviderCatalogEntry): string {
  const sub = entry.subscription;
  if (sub === undefined) {
    return '';
  }
  if (sub.kind === 'subscription-key') {
    return 'sanctioned subscription key · full native Excalibur';
  }
  return sub.risk === 'prohibited'
    ? 'drives the vendor’s official CLI · third-party token reuse is prohibited (at your own risk)'
    : 'drives the vendor’s official CLI · at your own risk';
}

/** The API-key (BYOK) rail: prompt the key env var, auto-configure good+fast, show it. */
async function setupApiKeyRail(
  deps: CliDeps,
  entry: ProviderCatalogEntry,
): Promise<ProvidersFileConfig> {
  const apiKeyEnv = await askEnvVarName(deps, entry.apiKeyEnv, false);
  if (entry.pair !== undefined) {
    deps.ui.info(
      `Auto-configured ${entry.label}: ${entry.pair.good} for coding, ${entry.pair.fast} for fast ` +
        `suggestions & compaction — both on ${apiKeyEnv}. Change either with \`excalibur models setup\`.`,
    );
    announceSaved(deps, apiKeyEnv);
    return pairConfig(entry, apiKeyEnv);
  }
  const model = (await deps.ui.ask(`${entry.label} model:`, { defaultAnswer: '' })).trim();
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
    deps.ui.info(
      `Your ${entry.label} subscription runs through a subscription key (sanctioned) — full native Excalibur.`,
    );
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
      `Excalibur will drive the official \`${sub.cli.command}\` CLI (${sub.cli.loginHint}). ` +
        'That passthrough adapter is coming — for now you can connect an API key instead.',
    );
  }
  const useKey = await deps.ui.confirm(`Set up a ${entry.label} API key now instead?`, {
    defaultYes: true,
  });
  if (useKey) {
    return setupApiKeyRail(deps, entry);
  }
  deps.ui.info(`No problem — run \`excalibur models setup\` anytime to connect ${entry.label}.`);
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
          label: 'Ollama (local) — free, no key',
          hint: ollamaDetected
            ? 'detected on this machine!'
            : 'install from ollama.com, then `ollama pull <model>`',
        };
      case 'self-hosted':
        return {
          label: 'Self-hosted / your own model',
          hint: 'vLLM · TGI · an internal Qwen/Llama gateway — your endpoint, key optional',
        };
      case 'mock':
        return { label: 'Mock', hint: 'offline / tests only — NOT a real model' };
      case 'later':
        return { label: 'Configure later' };
    }
  });

  const index = await deps.ui.select(
    'Which model provider? (Excalibur is free — use your subscription or API key, or run a local/own model)',
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
          `How do you use ${entry.label}?`,
          [
            { label: 'Subscription', hint: subscriptionHint(entry) },
            {
              label: 'API key',
              hint: 'pay-per-token · full native Excalibur (auto-pairs a good + fast model)',
            },
          ],
          { yes: false, defaultIndex: 0 },
        );
        return how === 0 ? setupSubscription(deps, entry) : setupApiKeyRail(deps, entry);
      }
      return setupApiKeyRail(deps, entry);
    }
    case 'ollama': {
      const model = await deps.ui.ask('Ollama model name [llama3]:', { defaultAnswer: 'llama3' });
      deps.ui.info(
        'Saved. Excalibur will use your local Ollama at http://localhost:11434 (no key, no cost). ' +
          'Make sure Ollama is running and the model is pulled (`ollama pull <model>`). ' +
          'Ghost-text needs a fast second model, so it stays off in single-model mode.',
      );
      return single('ollama', { type: 'ollama', baseUrl: 'http://localhost:11434', model });
    }
    case 'self-hosted': {
      // vLLM, TGI, SGLang, an internal Qwen/Llama gateway — any OpenAI-compatible
      // endpoint. Auth optional (keyless). This is the main path for Qwen run on
      // your own / private infra.
      const baseUrl = await deps.ui.ask('Your endpoint base URL [http://localhost:8000/v1]:', {
        defaultAnswer: 'http://localhost:8000/v1',
      });
      const model = await deps.ui.ask(
        'Model name served by your endpoint [Qwen/Qwen2.5-Coder-32B-Instruct]:',
        { defaultAnswer: 'Qwen/Qwen2.5-Coder-32B-Instruct' },
      );
      const apiKeyEnv = await askEnvVarNameOptional(deps, 'LLM_API_KEY');
      deps.ui.info(
        apiKeyEnv !== undefined
          ? `Saved. Excalibur will call ${baseUrl} with the bearer token in ${apiKeyEnv}.`
          : `Saved. Excalibur will call ${baseUrl} with no auth (keyless self-hosted endpoint).`,
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
