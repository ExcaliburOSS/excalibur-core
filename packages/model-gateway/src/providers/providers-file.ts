import { readFileSync } from 'node:fs';
import { ConfigValidationError } from '@excalibur/shared';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * `.excalibur/models/providers.yaml` schema (OSS spec §14, Build Contract §4.3).
 *
 * API keys are NEVER stored in this file — only the NAME of the environment
 * variable that holds the key (`apiKeyEnv`).
 */

export const providerTypeSchema = z.enum([
  'openai-compatible',
  'anthropic',
  'ollama',
  'vllm',
  'custom',
  'mock',
]);
export type ProviderType = z.infer<typeof providerTypeSchema>;

export const providerConfigSchema = z.object({
  type: providerTypeSchema,
  baseUrl: z.string().min(1).optional(),
  /** Name of the environment variable holding the API key — never the key itself. */
  apiKeyEnv: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  inputCostPerMillionTokensCents: z.number().finite().nonnegative().optional(),
  outputCostPerMillionTokensCents: z.number().finite().nonnegative().optional(),
  /** Per-request timeout in ms for real provider adapters (OSS-4, M2). */
  timeoutMs: z.number().int().positive().optional(),
  /** Retries after the first attempt for retryable failures (OSS-4, M2). */
  maxRetries: z.number().int().nonnegative().optional(),
  /** Advertised context-window size (tokens); informational for clients. */
  contextWindow: z.number().int().positive().optional(),
  /** Anthropic `anthropic-version` header override (e.g. `2023-06-01`). */
  apiVersion: z.string().min(1).optional(),
  /** OpenAI-compatible `openai-organization` header value. */
  organization: z.string().min(1).optional(),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

/**
 * The `providers:` section: well-known ROLE POINTERS plus named provider entries.
 * `default` names the main model; `cheap` names the fast/low-cost provider used
 * for latency- or volume-sensitive roles (ghost-text, context compaction). Role
 * pointers are NOT providers — each is the NAME of a configured provider.
 */
export type ProvidersSection = { default?: string; cheap?: string } & Record<
  string,
  ProviderConfig
>;

/** Keys in the providers section that point to a provider rather than BEING one. */
export const RESERVED_PROVIDER_KEYS: readonly string[] = ['default', 'cheap'];

const providersSectionSchema = z
  .record(z.unknown())
  .superRefine((value, ctx) => {
    const providerNames: string[] = [];
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'default' || key === 'cheap') {
        if (typeof entry !== 'string' || entry.trim().length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `providers.${key} must be the name of a configured provider`,
          });
        }
        continue;
      }
      providerNames.push(key);
      const parsed = providerConfigSchema.safeParse(entry);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key, ...issue.path],
            message: issue.message,
          });
        }
      }
    }
    if (providerNames.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'at least one provider must be configured',
      });
    }
    const defaultName = value['default'];
    if (
      typeof defaultName === 'string' &&
      defaultName.trim().length > 0 &&
      !providerNames.includes(defaultName)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default'],
        message: `providers.default points to "${defaultName}", which is not a configured provider`,
      });
    }
    const cheapName = value['cheap'];
    if (
      typeof cheapName === 'string' &&
      cheapName.trim().length > 0 &&
      !providerNames.includes(cheapName)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cheap'],
        message: `providers.cheap points to "${cheapName}", which is not a configured provider`,
      });
    }
  })
  .transform((value) => value as ProvidersSection);

export const providersFileSchema = z.object({
  providers: providersSectionSchema,
});
export type ProvidersFileConfig = z.infer<typeof providersFileSchema>;

/** M1 default: a single built-in mock provider (no real model calls). */
export const DEFAULT_PROVIDERS_CONFIG: ProvidersFileConfig = Object.freeze({
  providers: Object.freeze({
    default: 'mock',
    mock: Object.freeze({ type: 'mock' as const }),
  }) as unknown as ProvidersSection,
});

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Loads and validates a `providers.yaml` file.
 *
 * @throws ConfigValidationError when the file is unreadable, not valid YAML or
 *   fails schema validation. Error messages include path + problem; secret
 *   values never appear in messages (the file must not contain keys anyway).
 */
export function loadProvidersFile(filePath: string): ProvidersFileConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ConfigValidationError(
      `Cannot read providers file at ${filePath}: ${describeError(error)}`,
      { filePath },
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new ConfigValidationError(
      `Providers file ${filePath} is not valid YAML: ${describeError(error)}`,
      { filePath },
    );
  }

  const result = providersFileSchema.safeParse(parsed);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new ConfigValidationError(
      `Providers file ${filePath} is invalid: ${problems.join('; ')}`,
      { filePath, problems },
    );
  }
  return result.data;
}

/**
 * Resolves the API key for a provider from the environment variable named in
 * `apiKeyEnv`. Returns `null` when no variable is configured or the variable
 * is unset/empty. The resolved value must NEVER be logged or persisted.
 */
export function resolveApiKey(cfg: Pick<ProviderConfig, 'apiKeyEnv'>): string | null {
  if (cfg.apiKeyEnv === undefined || cfg.apiKeyEnv.length === 0) {
    return null;
  }
  const value = process.env[cfg.apiKeyEnv];
  return value !== undefined && value.length > 0 ? value : null;
}
