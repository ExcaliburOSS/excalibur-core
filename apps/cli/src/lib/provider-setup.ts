import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { isCommandOnPath } from '@excalibur/agent-runtime';
import type { ProviderConfig, ProvidersFileConfig } from '@excalibur/model-gateway';
import type { CliDeps } from '../deps';
import { providersFilePath } from './context';

/**
 * One-question model provider setup (onboarding spec §4), shared by
 * `excalibur init` and `excalibur models setup`. Hosted providers store the
 * NAME of an API key environment variable — never a key value.
 *
 * Excalibur is free OSS and requires a real LLM (the mock is a test double, not
 * a runtime fallback), so the choices are tiered: a FREE default (local Ollama —
 * no key, no cost), a RECOMMENDED paid model (Kimi K2 via Moonshot — bring your
 * own key), the other hosted providers, and the mock for offline/tests only.
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
 * The comfortable model-onboarding chooser (OSS, USER level — `excalibur init` /
 * `models setup`). Covers every scenario a user/org might run: a recommended
 * paid model (Kimi, BYOK), a free local model (Ollama), a free hosted tier
 * (Gemini/Groq with the user's own free key), their OWN self-hosted/on-infra
 * model (vLLM/TGI/internal Qwen — keyless or token-auth), the other hosted
 * providers, and the offline mock for tests. Excalibur never hosts/pays for a
 * model; everything here is the user's local or BYOK provider. Returns the
 * config to write, or null for "Configure later"; `--yes`/non-interactive writes
 * the explicit test mock. (Org/team-level central provisioning lives in
 * Excalibur Enterprise — admins configure providers once and users inherit them.)
 */
export async function promptProviderSetup(
  deps: CliDeps,
  options: { yes: boolean },
): Promise<ProvidersFileConfig | null> {
  if (options.yes || !deps.ui.isInteractive()) {
    return MOCK_ONLY; // tests/CI/offline — no key to prompt for
  }

  const ollamaDetected = isCommandOnPath('ollama', deps.env);
  const index = await deps.ui.select(
    'How should Excalibur call models?  (Excalibur is free — bring your own key, or run your own / a local model)',
    [
      {
        label: 'Ollama (local) — free, no key',
        hint: ollamaDetected
          ? 'detected on this machine!'
          : 'install from ollama.com, then `ollama pull <model>`',
      },
      {
        label: 'Kimi K2 (Moonshot) — recommended',
        hint: 'best quality · paid · your MOONSHOT_API_KEY',
      },
      { label: 'Free hosted tier (Gemini / Groq)', hint: 'free · your own free signup key' },
      {
        label: 'Self-hosted / your own model',
        hint: 'vLLM · TGI · an internal Qwen/Llama gateway — your endpoint, key optional',
      },
      { label: 'OpenAI', hint: 'BYOK · https://api.openai.com/v1' },
      { label: 'Anthropic (Claude)', hint: 'BYOK' },
      { label: 'OpenRouter', hint: 'BYOK · https://openrouter.ai/api/v1' },
      { label: 'Mock', hint: 'offline / tests only — NOT a real model' },
      { label: 'Configure later' },
    ],
    { yes: false, defaultIndex: 0 },
  );

  switch (index) {
    case 0: {
      const model = await deps.ui.ask('Ollama model name [llama3]:', { defaultAnswer: 'llama3' });
      deps.ui.info(
        'Saved. Excalibur will use your local Ollama at http://localhost:11434 (no key, no cost). ' +
          'Make sure Ollama is running and the model is pulled (`ollama pull <model>`).',
      );
      return single('ollama', { type: 'ollama', baseUrl: 'http://localhost:11434', model });
    }
    case 1: {
      const model = await deps.ui.ask('Kimi model [kimi-k2.7-code]:', {
        defaultAnswer: 'kimi-k2.7-code',
      });
      const apiKeyEnv = await askEnvVarName(deps, 'MOONSHOT_API_KEY', options.yes);
      announceSaved(deps, apiKeyEnv);
      return single('kimi', {
        type: 'openai-compatible',
        baseUrl: 'https://api.moonshot.ai/v1',
        apiKeyEnv,
        model,
        contextWindow: 262144,
      });
    }
    case 2: {
      const which = await deps.ui.select(
        'Which free tier? (you bring your own free signup key)',
        [
          {
            label: 'Google Gemini (Flash)',
            hint: 'free tier · aistudio.google.com → GEMINI_API_KEY',
          },
          { label: 'Groq', hint: 'free tier · console.groq.com → GROQ_API_KEY' },
        ],
        { yes: false, defaultIndex: 0 },
      );
      if (which === 0) {
        const model = await deps.ui.ask('Gemini model [gemini-2.0-flash]:', {
          defaultAnswer: 'gemini-2.0-flash',
        });
        const apiKeyEnv = await askEnvVarName(deps, 'GEMINI_API_KEY', options.yes);
        announceSaved(deps, apiKeyEnv);
        return single('gemini', {
          type: 'openai-compatible',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
          apiKeyEnv,
          model,
        });
      }
      const model = await deps.ui.ask('Groq model [llama-3.3-70b-versatile]:', {
        defaultAnswer: 'llama-3.3-70b-versatile',
      });
      const apiKeyEnv = await askEnvVarName(deps, 'GROQ_API_KEY', options.yes);
      announceSaved(deps, apiKeyEnv);
      return single('groq', {
        type: 'openai-compatible',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKeyEnv,
        model,
      });
    }
    case 3: {
      // Self-hosted / own infra: vLLM, TGI, SGLang, an internal Qwen/Llama
      // gateway — any OpenAI-compatible endpoint. Auth optional (keyless).
      const baseUrl = await deps.ui.ask('Your endpoint base URL [http://localhost:8000/v1]:', {
        defaultAnswer: 'http://localhost:8000/v1',
      });
      const model = await deps.ui.ask(
        'Model name served by your endpoint [Qwen/Qwen2.5-Coder-32B-Instruct]:',
        {
          defaultAnswer: 'Qwen/Qwen2.5-Coder-32B-Instruct',
        },
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
    case 4: {
      const baseUrl = await deps.ui.ask('Base URL [https://api.openai.com/v1]:', {
        defaultAnswer: 'https://api.openai.com/v1',
      });
      const apiKeyEnv = await askEnvVarName(deps, 'OPENAI_API_KEY', options.yes);
      announceSaved(deps, apiKeyEnv);
      return single('openai', { type: 'openai-compatible', baseUrl, apiKeyEnv });
    }
    case 5: {
      const apiKeyEnv = await askEnvVarName(deps, 'ANTHROPIC_API_KEY', options.yes);
      announceSaved(deps, apiKeyEnv);
      return single('anthropic', { type: 'anthropic', apiKeyEnv });
    }
    case 6: {
      const apiKeyEnv = await askEnvVarName(deps, 'OPENROUTER_API_KEY', options.yes);
      announceSaved(deps, apiKeyEnv);
      return single('openrouter', {
        type: 'openai-compatible',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKeyEnv,
      });
    }
    case 7:
      return MOCK_ONLY;
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
