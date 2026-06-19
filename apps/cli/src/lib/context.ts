import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PermissionEngine } from '@excalibur/agent-runtime';
import {
  DEFAULT_SAFETY_PRESET_ID,
  EXCALIBUR_DIR,
  EffectiveInstructionBuilder,
  SAFETY_PRESETS,
  buildMemoryContext,
  formatHitsAsSources,
  loadExcaliburConfig,
  type AdditionalContextSource,
  type LoadedExcaliburConfig,
} from '@excalibur/core';
import { searchRepoCode } from '@excalibur/context-engine';
import { coreProviderFactories } from '@excalibur/built-in-extensions';
import {
  DEFAULT_PROVIDERS_CONFIG,
  ModelGateway,
  RESERVED_PROVIDER_KEYS,
  loadProvidersFile,
  redactSecrets,
  type ChatInput,
  type ChatOutput,
  type ModelGatewayDeps,
  type ProvidersFileConfig,
} from '@excalibur/model-gateway';
import {
  ProviderError,
  type ExcaliburConfig,
  type InstructionSource,
  type Translator,
} from '@excalibur/shared';
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
  /**
   * Provider serving the `cheap` (fast/low-cost) role — ghost-text + compaction
   * route here for low latency/cost. Null when no distinct fast model is paired
   * (single-model configs), in which case those roles fall back to the default.
   */
  cheapProviderName: string | null;
  /**
   * Whether a provider is CONFIGURED (a `providers.yaml` exists — a real
   * provider OR an explicit `type: mock` for offline/tests). When false, no
   * provider is set up and model commands must refuse with setup guidance: the
   * mock is a test double, NEVER a silent runtime fallback (Excalibur requires a
   * real LLM). See {@link requireConfiguredModel}.
   */
  configured: boolean;
}

export function providersFilePath(repoRoot: string): string {
  return join(repoRoot, EXCALIBUR_DIR, 'models', 'providers.yaml');
}

/** Named provider entries (the `default`/`cheap` role pointers are not providers). */
export function providerNames(config: ProvidersFileConfig): string[] {
  return Object.keys(config.providers).filter((key) => !RESERVED_PROVIDER_KEYS.includes(key));
}

export function defaultProviderName(config: ProvidersFileConfig): string {
  const section: { default?: string } = config.providers;
  if (section.default !== undefined) {
    return section.default;
  }
  return providerNames(config)[0] ?? 'mock';
}

/**
 * The provider serving the `cheap` (fast/low-cost) role, if configured and
 * pointing at a real provider entry; null otherwise. Latency/volume-sensitive
 * roles (ghost-text, compaction) route here, falling back to the default model
 * when no distinct fast model is paired.
 */
export function cheapProviderName(config: ProvidersFileConfig): string | null {
  const section: { cheap?: string } = config.providers;
  const name = section.cheap;
  if (name === undefined || name.length === 0) {
    return null;
  }
  return providerNames(config).includes(name) ? name : null;
}

/**
 * Real-provider wiring (OSS-4, M2): a configured `providers.yaml` gets real
 * adapters (anthropic / openai-compatible / vllm / custom / ollama) via the
 * Core factory map and the default fetch transport. The built-in mock stays
 * the zero-config default, and a real provider that fails to construct (e.g. a
 * missing key) falls back to mock through `chatWithGuidance`.
 */
// Providers are sourced from the EXT-6 `core-providers` built-in pack's
// model_provider contributions (synchronous — the pack is a static const), so
// the gateway gets its real adapters through the extension representation.
const GATEWAY_DEPS: ModelGatewayDeps = { factories: coreProviderFactories() };

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
      cheapProviderName: cheapProviderName(providers),
      configured: true, // a providers.yaml exists (real, or an explicit mock)
    };
  }
  // No providers.yaml: UNCONFIGURED. A gateway is still returned (so non-model
  // commands like `models list` work), but `configured: false` makes every
  // model command refuse via requireConfiguredModel — the mock is never a
  // silent runtime fallback.
  return {
    gateway: new ModelGateway(DEFAULT_PROVIDERS_CONFIG, GATEWAY_DEPS),
    providers: DEFAULT_PROVIDERS_CONFIG,
    providersPath: null,
    providerName: defaultProviderName(DEFAULT_PROVIDERS_CONFIG),
    cheapProviderName: null,
    configured: false,
  };
}

/**
 * Guards a model command: when no provider is configured, refuses with setup
 * guidance instead of silently running the mock. Excalibur requires a real LLM;
 * the mock is a test double (used only when a `providers.yaml` explicitly sets
 * `type: mock`). Call this right after {@link loadGatewayContext} in any command
 * or shell turn that will actually call the model.
 */
export function requireConfiguredModel(context: GatewayContext, t: Translator): void {
  if (!context.configured) {
    throw new CliUsageError(t('context.noProvider'));
  }
}

export function loadConfigContext(repoRoot: string): LoadedExcaliburConfig {
  return loadExcaliburConfig(repoRoot);
}

/** The active safety preset line printed by init/run/patch (onboarding §5). */
export function safetyLine(t: Translator, config: ExcaliburConfig): string {
  const presetId = config.safety?.preset ?? DEFAULT_SAFETY_PRESET_ID;
  const preset = SAFETY_PRESETS[presetId];
  const description =
    preset !== undefined
      ? t('context.safetyOk')
      : t('context.safetyUnknown', { preset: DEFAULT_SAFETY_PRESET_ID });
  return t('context.safetyLine', { preset: presetId, description });
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
 * Gateway chat. A configured provider's failure (`auth_failed` from a bad key,
 * `rate_limited`, …) is surfaced UNCHANGED so the user can fix it; a configured
 * provider whose adapter is missing from the build is turned into actionable
 * setup guidance. There is NO mock fallback — the caller must have already
 * passed {@link requireConfiguredModel} (the mock is a test double, never a
 * silent runtime substitute).
 */
export async function chatWithGuidance(
  deps: CliDeps,
  context: GatewayContext,
  input: ChatInput,
): Promise<GuidedChatResult> {
  requireConfiguredModel(context, deps.t);
  try {
    const output = await context.gateway.chat(input);
    return { output, provider: context.providerName };
  } catch (error) {
    throw guidanceError(context, error, deps.t);
  }
}

/**
 * Maps a provider error to actionable guidance: a not-implemented adapter
 * becomes a setup hint; every other failure (auth/rate-limit/network/…) is
 * surfaced unchanged so the user fixes the real cause. NEVER returns a mock.
 */
function guidanceError(context: GatewayContext, error: unknown, t: Translator): unknown {
  if (error instanceof ProviderError && FALLBACK_CODES.has(error.code)) {
    return new CliUsageError(
      t('context.providerUnusable', { provider: context.providerName, error: error.message }),
    );
  }
  return error;
}

export interface StreamedChatResult {
  output: ChatOutput;
  /** Provider that answered. */
  provider: string;
  /** True when the output was streamed delta-by-delta (vs. assembled at once). */
  streamed: boolean;
}

/**
 * Streaming counterpart of {@link chatWithGuidance}. No mock fallback: a
 * configured provider's failure is surfaced unchanged (a not-implemented
 * adapter becomes setup guidance), and the caller must have already passed
 * {@link requireConfiguredModel}.
 */
export async function streamWithGuidance(
  deps: CliDeps,
  context: GatewayContext,
  input: ChatInput,
  onDelta: (text: string) => void,
): Promise<StreamedChatResult> {
  requireConfiguredModel(context, deps.t);
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
    // A mid-stream failure (after at least one delta) is surfaced UNCHANGED —
    // partial output is never retroactively reinterpreted. A pre-delta failure
    // becomes setup guidance (a not-implemented adapter) or surfaces as-is.
    if (sawDelta) {
      throw error;
    }
    throw guidanceError(context, error, deps.t);
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
  // Knowledge Compounding (M2.6): retrieve project memory relevant to the files
  // already in context and inject it as a context source — the agent is primed
  // with prior decisions/rejections/risks for those paths. Best-effort + scoped
  // (no relevant memory → nothing injected).
  const repoSources = options.additionalSources ?? [];
  const queryPaths = repoSources
    .map((source) => source.path)
    .filter((path) => !path.startsWith(EXCALIBUR_DIR) && !path.startsWith('.excalibur'));
  const memorySource = queryPaths.length > 0 ? buildMemoryContext(repoRoot, queryPaths) : null;
  const additionalSources: AdditionalContextSource[] = [
    ...repoSources,
    ...(memorySource !== null ? [memorySource] : []),
  ];

  const builder = new EffectiveInstructionBuilder({ repoRoot });
  const built = await builder.build({
    repositoryPath: repoRoot,
    includeUserGlobal: deps.includeUserGlobal,
    ...(options.workflowId !== undefined ? { workflowId: options.workflowId } : {}),
    ...(options.autonomyLevel !== undefined ? { autonomyLevel: options.autonomyLevel } : {}),
    ...(additionalSources.length > 0 ? { additionalSources } : {}),
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
    throw new CliUsageError(deps.t('context.refuseRead', { relPath, reason: decision.reason }));
  }
  if (decision.requiresConfirmation) {
    const proceed = await deps.ui.confirm(
      deps.t('context.confirmRead', { relPath, reason: decision.reason }),
      {
        yes: options.yes,
        defaultYes: false,
      },
    );
    if (!proceed) {
      throw new CliUsageError(deps.t('context.declinedRead', { relPath }));
    }
  }

  const filePath = join(repoRoot, relPath);
  if (!existsSync(filePath)) {
    throw new CliUsageError(deps.t('context.fileNotFound', { relPath }));
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
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
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
