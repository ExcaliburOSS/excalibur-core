import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PermissionEngine } from '@excalibur/agent-runtime';
import {
  DEFAULT_SAFETY_PRESET_ID,
  EXCALIBUR_DIR,
  EffectiveInstructionBuilder,
  SAFETY_PRESETS,
  loadExcaliburConfig,
  type LoadedExcaliburConfig,
} from '@excalibur/core';
import {
  DEFAULT_PROVIDERS_CONFIG,
  ModelGateway,
  loadProvidersFile,
  redactSecrets,
  type ChatInput,
  type ChatOutput,
  type ProvidersFileConfig,
} from '@excalibur/model-gateway';
import { ProviderError, type ExcaliburConfig, type InstructionSource } from '@excalibur/shared';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';

/** Resolved model setup for a repository. */
export interface GatewayContext {
  gateway: ModelGateway;
  providers: ProvidersFileConfig;
  /** Path of `.excalibur/models/providers.yaml` when it exists. */
  providersPath: string | null;
  /** Name of the provider the gateway resolves by default. */
  providerName: string;
}

export function providersFilePath(repoRoot: string): string {
  return join(repoRoot, EXCALIBUR_DIR, 'models', 'providers.yaml');
}

/** Named provider entries (the `default` pointer is not a provider). */
export function providerNames(config: ProvidersFileConfig): string[] {
  return Object.keys(config.providers).filter((key) => key !== 'default');
}

export function defaultProviderName(config: ProvidersFileConfig): string {
  const section: { default?: string } = config.providers;
  if (section.default !== undefined) {
    return section.default;
  }
  return providerNames(config)[0] ?? 'mock';
}

/**
 * Loads the model gateway for a repository: `providers.yaml` when present,
 * the built-in mock default otherwise (every command works without init).
 */
export function loadGatewayContext(repoRoot: string): GatewayContext {
  const filePath = providersFilePath(repoRoot);
  if (existsSync(filePath)) {
    const providers = loadProvidersFile(filePath);
    return {
      gateway: new ModelGateway(providers),
      providers,
      providersPath: filePath,
      providerName: defaultProviderName(providers),
    };
  }
  return {
    gateway: new ModelGateway(DEFAULT_PROVIDERS_CONFIG),
    providers: DEFAULT_PROVIDERS_CONFIG,
    providersPath: null,
    providerName: defaultProviderName(DEFAULT_PROVIDERS_CONFIG),
  };
}

export function loadConfigContext(repoRoot: string): LoadedExcaliburConfig {
  return loadExcaliburConfig(repoRoot);
}

/** The active safety preset line printed by init/run/patch (onboarding §5). */
export function safetyLine(config: ExcaliburConfig): string {
  const presetId = config.safety?.preset ?? DEFAULT_SAFETY_PRESET_ID;
  const preset = SAFETY_PRESETS[presetId];
  const description =
    preset !== undefined
      ? 'No files will be modified without approval.'
      : `Unknown preset — falling back to ${DEFAULT_SAFETY_PRESET_ID} rules.`;
  return `Safety: ${presetId} — ${description}`;
}

export interface GuidedChatResult {
  output: ChatOutput;
  /** Provider that actually answered (mock when a real provider fell back). */
  provider: string;
}

/**
 * Gateway chat with friendly guidance (onboarding §4): a configured real
 * provider (M2) or a broken provider setup never surfaces a low-level error —
 * the CLI explains the situation and falls back to the built-in mock.
 */
export async function chatWithGuidance(
  deps: CliDeps,
  context: GatewayContext,
  input: ChatInput,
): Promise<GuidedChatResult> {
  try {
    const output = await context.gateway.chat(input);
    return { output, provider: context.providerName };
  } catch (error) {
    if (!(error instanceof ProviderError)) {
      throw error;
    }
    if (error.code === 'provider_not_implemented') {
      deps.ui.warn(
        `Provider "${context.providerName}" is configured, but real model providers arrive in M2. ` +
          'Using the built-in mock provider for this command.',
      );
    } else {
      deps.ui.warn(
        'No usable model provider is configured. Run `excalibur models setup` to pick one — ' +
          'using the built-in mock provider for now (the M1 default).',
      );
    }
    const fallback = new ModelGateway(DEFAULT_PROVIDERS_CONFIG);
    const output = await fallback.chat(input);
    return { output, provider: 'mock' };
  }
}

export interface EffectiveContext {
  instructionsMarkdown: string;
  sources: InstructionSource[];
  warnings: string[];
  sourcePaths: string[];
}

/** Builds the ISD effective-instruction context for prompt prepending (ISD-5). */
export async function buildEffectiveContext(
  deps: CliDeps,
  repoRoot: string,
  options: { workflowId?: string; autonomyLevel?: number } = {},
): Promise<EffectiveContext> {
  const builder = new EffectiveInstructionBuilder({ repoRoot });
  const built = await builder.build({
    repositoryPath: repoRoot,
    includeUserGlobal: deps.includeUserGlobal,
    ...(options.workflowId !== undefined ? { workflowId: options.workflowId } : {}),
    ...(options.autonomyLevel !== undefined ? { autonomyLevel: options.autonomyLevel } : {}),
  });
  return {
    instructionsMarkdown: built.instructionsMarkdown,
    sources: built.sources,
    warnings: built.warnings,
    sourcePaths: built.sources.map((source) => source.path),
  };
}

/**
 * Reads a user-supplied file for inclusion in a model prompt, enforcing the
 * Core security guarantees (Build Contract §4.4):
 *
 * 1. The repository-relative path is checked against the configured
 *    blocked-path patterns (`.env`, `**` + `/*.pem`, `**` + `/*.key`,
 *    `**` + `/secrets/**`, …) via `PermissionEngine.checkPath(relPath,
 *    'read')`. A blocked path is refused outright; an `'ask'` decision asks
 *    for explicit confirmation before reading. This prevents
 *    `excalibur explain .env` from slurping a secret file into a prompt.
 * 2. The file content is passed through `redactSecrets` before it is placed
 *    in the prompt (and, downstream, before it is persisted to the
 *    interaction artifact), so any secrets that do live in an allowed file
 *    never reach the model endpoint or the on-disk transcript.
 *
 * Returns the redacted content. Throws `CliUsageError` (exit 2) when the file
 * is missing, blocked by policy, or the user declines an `'ask'` confirmation.
 */
export async function readUserSuppliedFile(
  deps: CliDeps,
  repoRoot: string,
  relPath: string,
  options: { yes?: boolean } = {},
): Promise<string> {
  const { config } = loadConfigContext(repoRoot);
  const engine = new PermissionEngine(config.permissions);
  const decision = engine.checkPath(relPath, 'read');

  if (!decision.allowed) {
    throw new CliUsageError(
      `Refusing to read "${relPath}": ${decision.reason} ` +
        'Blocked paths (secrets, keys, .env) are never read into model prompts.',
    );
  }
  if (decision.requiresConfirmation) {
    const proceed = await deps.ui.confirm(`Read "${relPath}" into the prompt? (${decision.reason})`, {
      yes: options.yes,
      defaultYes: false,
    });
    if (!proceed) {
      throw new CliUsageError(`Declined to read "${relPath}".`);
    }
  }

  const filePath = join(repoRoot, relPath);
  if (!existsSync(filePath)) {
    throw new CliUsageError(`File not found: ${relPath}`);
  }
  // Always redact: an allowed file can still contain an embedded credential.
  return redactSecrets(readFileSync(filePath, 'utf8'));
}

/**
 * Redacts secrets from a local working-tree diff before it is embedded in a
 * model prompt or persisted (Build Contract §4.4: secret redaction applies to
 * diff content too — staged changes routinely include leaked credentials).
 */
export function redactDiff(diff: string): string {
  return redactSecrets(diff);
}

/** System prompt = effective instructions (when any) + the role line. */
export function systemPrompt(effective: EffectiveContext, roleLine: string): string {
  if (effective.instructionsMarkdown.length === 0) {
    return roleLine;
  }
  return `${effective.instructionsMarkdown}\n\n${roleLine}`;
}
