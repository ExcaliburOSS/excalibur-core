/**
 * Pure helpers for the in-shell `/models` picker (P1.14c). Kept separate from
 * the REPL so the selection logic — which providers are switchable, how they're
 * labelled, and writing the chosen default — is unit-testable without a TTY.
 */

/** Declared model capabilities (mirrors providers.yaml `capabilities`). */
export interface ProviderCapabilities {
  reasoning?: boolean;
  vision?: boolean;
  tools?: boolean;
}

/** One provider the user can switch the active model to. */
export interface SwitchableProvider {
  name: string;
  model?: string;
  capabilities?: ProviderCapabilities;
  /** True for the provider currently pointed to by `default`. */
  current: boolean;
}

/** The reserved role-pointer keys in the providers section (not providers). */
const RESERVED = new Set(['default', 'cheap']);

/**
 * Lists the named providers a user can switch to from a providers.yaml section:
 * excludes the `default`/`cheap` role pointers and the `mock` test double, and
 * marks the one currently active. Order is preserved (catalog/onboarding order).
 */
export function listSwitchableProviders(
  section: Record<string, unknown>,
  current: string,
): SwitchableProvider[] {
  const out: SwitchableProvider[] = [];
  for (const [name, value] of Object.entries(section)) {
    if (RESERVED.has(name) || value === null || typeof value !== 'object') {
      continue;
    }
    const cfg = value as { type?: string; model?: string; capabilities?: ProviderCapabilities };
    if (cfg.type === 'mock') {
      continue;
    }
    out.push({
      name,
      ...(cfg.model !== undefined ? { model: cfg.model } : {}),
      ...(cfg.capabilities !== undefined ? { capabilities: cfg.capabilities } : {}),
      current: name === current,
    });
  }
  return out;
}

/** A short capability badge, e.g. "reasoning · vision · tools" (empty if none). */
export function capabilityHint(caps: ProviderCapabilities | undefined): string {
  if (caps === undefined) {
    return '';
  }
  const flags: string[] = [];
  if (caps.reasoning === true) flags.push('reasoning');
  if (caps.vision === true) flags.push('vision');
  if (caps.tools === true) flags.push('tools');
  return flags.join(' · ');
}

/** The dim hint shown next to a provider in the picker (model + capabilities). */
export function providerHint(provider: SwitchableProvider): string {
  return [provider.model, capabilityHint(provider.capabilities)]
    .filter((s): s is string => s !== undefined && s.length > 0)
    .join(' · ');
}
