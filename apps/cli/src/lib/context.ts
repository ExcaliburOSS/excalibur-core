import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PermissionEngine } from '@excalibur/agent-runtime';
import {
  DEFAULT_SAFETY_PRESET_ID,
  EXCALIBUR_DIR,
  EffectiveInstructionBuilder,
  SAFETY_PRESETS,
  formatHitsAsSources,
  loadExcaliburConfig,
  type AdditionalContextSource,
  type LoadedExcaliburConfig,
} from '@excalibur/core';
import { searchRepoCode } from '@excalibur/context-engine';
import {
  CORE_PROVIDER_FACTORIES,
  DEFAULT_PROVIDERS_CONFIG,
  ModelGateway,
  loadProvidersFile,
  redactSecrets,
  type ChatInput,
  type ChatOutput,
  type ModelGatewayDeps,
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
 * Real-provider wiring (OSS-4, M2): a configured `providers.yaml` gets real
 * adapters (anthropic / openai-compatible / vllm / custom / ollama) via the
 * Core factory map and the default fetch transport. The built-in mock stays
 * the zero-config default, and a real provider that fails to construct (e.g. a
 * missing key) falls back to mock through `chatWithGuidance`.
 */
const GATEWAY_DEPS: ModelGatewayDeps = { factories: CORE_PROVIDER_FACTORIES };

/**
 * Loads the model gateway for a repository: `providers.yaml` when present,
 * the built-in mock default otherwise (every command works without init).
 */
export function loadGatewayContext(repoRoot: string): GatewayContext {
  const filePath = providersFilePath(repoRoot);
  if (existsSync(filePath)) {
    const providers = loadProvidersFile(filePath);
    return {
      gateway: new ModelGateway(providers, GATEWAY_DEPS),
      providers,
      providersPath: filePath,
      providerName: defaultProviderName(providers),
    };
  }
  return {
    gateway: new ModelGateway(DEFAULT_PROVIDERS_CONFIG, GATEWAY_DEPS),
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
 * Provider-error codes that mean "no usable provider is wired up", for which
 * the CLI silently falls back to the built-in mock. A real provider that is
 * wired up but *rejects* the call (bad key, bad request) is NOT in this set —
 * those errors are surfaced so the user can fix their configuration.
 */
const FALLBACK_CODES = new Set(['provider_not_found', 'provider_not_implemented']);

/**
 * Gateway chat with friendly guidance (onboarding §4).
 *
 * A *missing or not-yet-executable* provider never surfaces a low-level error:
 * the CLI explains the situation and falls back to the built-in mock. A
 * *configured real provider that fails* (M2) — e.g. `auth_failed` from a bad
 * key, or `invalid_request` — is surfaced unchanged so the user can fix it,
 * rather than silently masked behind the mock.
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
    if (!(error instanceof ProviderError) || !FALLBACK_CODES.has(error.code)) {
      // Real provider failures (auth_failed, invalid_request, rate_limited,
      // server_error, timeout, network_error) and non-provider errors are
      // surfaced, not masked behind the mock.
      throw error;
    }
    if (error.code === 'provider_not_implemented') {
      deps.ui.warn(
        `Provider "${context.providerName}" is configured, but its adapter is not available in this build. ` +
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

export interface StreamedChatResult {
  output: ChatOutput;
  /** Provider that actually answered (mock when a real provider fell back). */
  provider: string;
  /** True when the output was streamed delta-by-delta (vs. assembled at once). */
  streamed: boolean;
}

/**
 * Streaming counterpart of {@link chatWithGuidance} (M2, Slice 2).
 *
 * Mirrors the fallback contract EXACTLY: a *missing/not-yet-executable*
 * provider whose error has a {@link FALLBACK_CODES} code AND is raised BEFORE
 * the first delta falls back to the built-in mock and streams from it
 * (`provider: 'mock'`). A *configured real provider that fails* — or any error
 * raised mid-stream after at least one delta — is surfaced unchanged so the
 * user can fix their configuration (mid-stream output is never silently
 * replaced by mock content).
 */
export async function streamWithGuidance(
  deps: CliDeps,
  context: GatewayContext,
  input: ChatInput,
  onDelta: (text: string) => void,
): Promise<StreamedChatResult> {
  let sawDelta = false;
  try {
    const gen = context.gateway.streamWithUsage(input);
    let result = await gen.next();
    while (!result.done) {
      const chunk = result.value.content;
      if (chunk.length > 0) {
        sawDelta = true;
        onDelta(chunk);
      }
      result = await gen.next();
    }
    return { output: result.value, provider: context.providerName, streamed: true };
  } catch (error) {
    const fallbackEligible =
      error instanceof ProviderError && FALLBACK_CODES.has(error.code);
    // Only a fallback-code error raised before any delta may fall back; a real
    // failure, or any error mid-stream, is surfaced unchanged.
    if (!fallbackEligible || sawDelta) {
      throw error;
    }
    if (error.code === 'provider_not_implemented') {
      deps.ui.warn(
        `Provider "${context.providerName}" is configured, but its adapter is not available in this build. ` +
          'Using the built-in mock provider for this command.',
      );
    } else {
      deps.ui.warn(
        'No usable model provider is configured. Run `excalibur models setup` to pick one — ' +
          'using the built-in mock provider for now (the M1 default).',
      );
    }
    const fallback = new ModelGateway(DEFAULT_PROVIDERS_CONFIG);
    const gen = fallback.streamWithUsage(input);
    let result = await gen.next();
    while (!result.done) {
      if (result.value.content.length > 0) {
        onDelta(result.value.content);
      }
      result = await gen.next();
    }
    return { output: result.value, provider: 'mock', streamed: true };
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
  options: {
    workflowId?: string;
    autonomyLevel?: number;
    /** Retrieved repo-context sources injected at precedence 6 (M2). */
    additionalSources?: AdditionalContextSource[];
  } = {},
): Promise<EffectiveContext> {
  const builder = new EffectiveInstructionBuilder({ repoRoot });
  const built = await builder.build({
    repositoryPath: repoRoot,
    includeUserGlobal: deps.includeUserGlobal,
    ...(options.workflowId !== undefined ? { workflowId: options.workflowId } : {}),
    ...(options.autonomyLevel !== undefined ? { autonomyLevel: options.autonomyLevel } : {}),
    ...(options.additionalSources !== undefined
      ? { additionalSources: options.additionalSources }
      : {}),
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

/** Path's basename without its final extension: `src/auth/login.ts` → `login`. */
function pathStem(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Derives a retrieval query from a source file's exported identifiers and its
 * path stem (M2). Pulls `export … <name>`, Python `def`/`class`, Go `func`,
 * Rust `pub fn` names — a deterministic, language-agnostic best effort.
 */
export function deriveNeighborQuery(relPath: string, content: string): string {
  const identifiers = new Set<string>();
  const declRe =
    /\b(?:export\s+(?:async\s+)?(?:function|class|const|interface|type|enum)|def|class|func|pub\s+fn)\s+([A-Za-z_]\w*)/g;
  let match: RegExpExecArray | null;
  while ((match = declRe.exec(content)) !== null) {
    const name = match[1];
    if (name !== undefined) {
      identifiers.add(name);
    }
  }
  // Also pull imported identifiers so the query overlaps with neighbor files.
  const importRe = /import\s+(?:type\s+)?\{([^}]+)\}/g;
  while ((match = importRe.exec(content)) !== null) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (name !== undefined && name.length > 0) {
        identifiers.add(name);
      }
    }
  }
  const stem = pathStem(relPath);
  return [stem, ...identifiers].join(' ');
}

/**
 * Retrieves permission-gated neighbor context for a target file (M2,
 * `explain`/`review`). Runs deterministic retrieval anchored on `relPath`
 * (same-dir + imported neighbors), then DROPS any hit whose path is not
 * readable per the existing `PermissionEngine.checkPath(path, 'read')` — so a
 * blocked neighbor (`.env`, `secrets/…`) never enters the prompt. The
 * surviving hits are formatted via `formatHitsAsSources` (one retrieval pass),
 * whose content is redacted at the source and again by the builder's render()
 * (redaction + caps).
 */
export async function buildNeighborContext(
  deps: CliDeps,
  repoRoot: string,
  anchorPath: string,
  query: string,
  options: { maxFiles?: number } = {},
): Promise<AdditionalContextSource[]> {
  const { config } = loadConfigContext(repoRoot);
  const engine = new PermissionEngine(config.permissions);

  const result = await searchRepoCode(repoRoot, {
    query,
    anchorPath,
    ...(options.maxFiles !== undefined ? { maxFiles: options.maxFiles } : {}),
  });

  // Permission-gate every neighbor by EXACT path; drop anything not outright
  // allowed (a blocked path, or one that would merely require confirmation).
  // Retrieval runs once and we format only the surviving hits — no substring
  // matching, no second retrieval pass.
  const allowedHits = result.hits.filter((hit) => {
    const decision = engine.checkPath(hit.path, 'read');
    return decision.allowed && !decision.requiresConfirmation;
  });
  if (allowedHits.length === 0) {
    return [];
  }
  return formatHitsAsSources(allowedHits, result.terms);
}
