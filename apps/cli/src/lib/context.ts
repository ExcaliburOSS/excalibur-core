import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
  type ChatInput,
  type ChatOutput,
  type ProvidersFileConfig,
} from '@excalibur/model-gateway';
import { ProviderError, type ExcaliburConfig, type InstructionSource } from '@excalibur/shared';
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

/** System prompt = effective instructions (when any) + the role line. */
export function systemPrompt(effective: EffectiveContext, roleLine: string): string {
  if (effective.instructionsMarkdown.length === 0) {
    return roleLine;
  }
  return `${effective.instructionsMarkdown}\n\n${roleLine}`;
}
