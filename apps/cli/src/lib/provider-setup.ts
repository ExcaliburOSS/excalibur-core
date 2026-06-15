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
  deps.ui.info(
    `Saved. Set ${apiKeyEnv} to your API key (Excalibur stores only the variable name) and ` +
      'this provider will be used. With no key set, commands ask you to configure one — there is no mock fallback.',
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
 * Runs the chooser. Returns the providers config to write, or `null` for
 * "Configure later". `--yes` / non-interactive stdin selects the explicit mock
 * (the offline/test double) since there is no key to prompt for. Interactively,
 * the FREE local Ollama is the default selection and Kimi K2 the recommendation.
 */
export async function promptProviderSetup(
  deps: CliDeps,
  options: { yes: boolean },
): Promise<ProvidersFileConfig | null> {
  // Non-interactive: there is nothing to prompt and no key to capture, so write
  // the explicit mock (tests/CI/offline). A real provider needs interaction.
  if (options.yes || !deps.ui.isInteractive()) {
    return MOCK_ONLY;
  }

  const ollamaDetected = isCommandOnPath('ollama', deps.env);
  const OLLAMA_INDEX = 0;
  const index = await deps.ui.select(
    'How should Excalibur call models? (Excalibur is free OSS — bring your own key for paid models)',
    [
      {
        label: 'Ollama (local) — free',
        hint: ollamaDetected ? 'detected on this machine!' : 'install from ollama.com, then pull a model',
      },
      {
        label: 'Kimi K2 (Moonshot) — recommended',
        hint: 'best quality · paid · bring your MOONSHOT_API_KEY',
      },
      { label: 'OpenAI-compatible API', hint: 'any OpenAI-style endpoint · BYOK' },
      { label: 'Anthropic', hint: 'Claude models · BYOK' },
      { label: 'OpenRouter', hint: 'https://openrouter.ai/api/v1 · BYOK' },
      { label: 'Mock', hint: 'offline / tests only — NOT a real model' },
      { label: 'Configure later' },
    ],
    { yes: false, defaultIndex: OLLAMA_INDEX },
  );

  switch (index) {
    case 0: {
      const model = await deps.ui.ask('Ollama model name [llama3]:', {
        yes: options.yes,
        defaultAnswer: 'llama3',
      });
      deps.ui.info(
        'Saved. Excalibur will use your local Ollama server at http://localhost:11434 (no API key, ' +
          'no cost). Make sure Ollama is running and the model is pulled (`ollama pull <model>`).',
      );
      return single('ollama', { type: 'ollama', baseUrl: 'http://localhost:11434', model });
    }
    case 1: {
      const model = await deps.ui.ask('Kimi model [kimi-k2.7-code]:', {
        yes: options.yes,
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
      const baseUrl = await deps.ui.ask('Base URL [https://api.openai.com/v1]:', {
        yes: options.yes,
        defaultAnswer: 'https://api.openai.com/v1',
      });
      const apiKeyEnv = await askEnvVarName(deps, 'OPENAI_API_KEY', options.yes);
      announceSaved(deps, apiKeyEnv);
      return single('openai', { type: 'openai-compatible', baseUrl, apiKeyEnv });
    }
    case 3: {
      const apiKeyEnv = await askEnvVarName(deps, 'ANTHROPIC_API_KEY', options.yes);
      announceSaved(deps, apiKeyEnv);
      return single('anthropic', { type: 'anthropic', apiKeyEnv });
    }
    case 4: {
      const apiKeyEnv = await askEnvVarName(deps, 'OPENROUTER_API_KEY', options.yes);
      announceSaved(deps, apiKeyEnv);
      return single('openrouter', {
        type: 'openai-compatible',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKeyEnv,
      });
    }
    case 5:
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
