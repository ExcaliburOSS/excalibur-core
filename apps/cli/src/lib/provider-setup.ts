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
 * NAME of an API key environment variable — never a key value. M1 honesty:
 * real providers are written to providers.yaml but execution stays on the
 * built-in mock until M2.
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

function withMock(name: string, config: ProviderConfig): ProvidersFileConfig {
  return {
    providers: {
      default: name,
      [name]: config,
      // The mock stays configured so every command keeps working in M1.
      ...(name === 'mock' ? {} : { mock: { type: 'mock' } }),
    } as ProvidersFileConfig['providers'],
  };
}

/**
 * Runs the chooser. Returns the providers config to write, or `null` when
 * the user picked "Configure later". `--yes` (and non-interactive stdin)
 * selects the M1 default: the built-in mock provider.
 */
export async function promptProviderSetup(
  deps: CliDeps,
  options: { yes: boolean },
): Promise<ProvidersFileConfig | null> {
  const ollamaDetected = isCommandOnPath('ollama', deps.env);
  const mockIndex = 4;
  const index = await deps.ui.select(
    'How should Excalibur call models?',
    [
      { label: 'OpenAI-compatible API', hint: 'any OpenAI-style endpoint (M2)' },
      { label: 'Anthropic', hint: 'Claude models (M2)' },
      { label: 'OpenRouter', hint: 'openai-compatible, https://openrouter.ai/api/v1 (M2)' },
      {
        label: 'Ollama (local)',
        hint: ollamaDetected ? 'detected on this machine! (M2)' : 'http://localhost:11434 (M2)',
      },
      { label: 'Mock (built-in)', hint: 'deterministic, no network — the M1 default' },
      { label: 'Configure later' },
    ],
    { yes: options.yes, defaultIndex: mockIndex },
  );

  switch (index) {
    case 0: {
      const baseUrl = await deps.ui.ask('Base URL [https://api.openai.com/v1]:', {
        yes: options.yes,
        defaultAnswer: 'https://api.openai.com/v1',
      });
      const apiKeyEnv = await askEnvVarName(deps, 'OPENAI_API_KEY', options.yes);
      deps.ui.warn(
        'Honest M1 note: this provider is saved, but real model calls arrive in M2 — ' +
          'commands keep using the built-in mock until then.',
      );
      return withMock('openai', { type: 'openai-compatible', baseUrl, apiKeyEnv });
    }
    case 1: {
      const apiKeyEnv = await askEnvVarName(deps, 'ANTHROPIC_API_KEY', options.yes);
      deps.ui.warn(
        'Honest M1 note: this provider is saved, but real model calls arrive in M2 — ' +
          'commands keep using the built-in mock until then.',
      );
      return withMock('anthropic', { type: 'anthropic', apiKeyEnv });
    }
    case 2: {
      const apiKeyEnv = await askEnvVarName(deps, 'OPENROUTER_API_KEY', options.yes);
      deps.ui.warn(
        'Honest M1 note: this provider is saved, but real model calls arrive in M2 — ' +
          'commands keep using the built-in mock until then.',
      );
      return withMock('openrouter', {
        type: 'openai-compatible',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKeyEnv,
      });
    }
    case 3: {
      const model = await deps.ui.ask('Ollama model name [llama3]:', {
        yes: options.yes,
        defaultAnswer: 'llama3',
      });
      deps.ui.warn(
        'Honest M1 note: this provider is saved, but real model calls arrive in M2 — ' +
          'commands keep using the built-in mock until then.',
      );
      return withMock('ollama', { type: 'ollama', baseUrl: 'http://localhost:11434', model });
    }
    case 4:
      return withMock('mock', { type: 'mock' });
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
