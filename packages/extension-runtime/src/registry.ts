import { ContributionRegistry, type Contribution, type ContributionSource } from './contributions';
import { HookRegistry } from './hooks';
import type { ExtensionManifest } from './manifest';

/**
 * One extension as seen by the runtime after loading. Built-ins have no
 * directory (`dir: null`); project/local extensions point at the directory
 * their files live in. Load failures are recorded per-extension (`status:
 * 'error'` + `error` message) instead of crashing the whole load.
 */
export type LoadedExtension = {
  manifest: ExtensionManifest;
  source: ContributionSource;
  dir: string | null;
  status: 'loaded' | 'error' | 'blocked';
  error?: string;
  /**
   * For local programmatic extensions: the value exported by the compiled
   * entrypoint (the `defineExtension(...)` result). Its `register(ctx)` is
   * invoked by the Extension SDK host, not by the runtime loader (M1 loads
   * and validates the entrypoint only).
   */
  instance?: unknown;
};

/**
 * A built-in extension pack: a manifest plus pre-parsed contributions.
 * `@excalibur/built-in-extensions` exports the default packs; `loadExtensions`
 * registers them first so project files can override them.
 */
export type BuiltInExtensionPack = {
  manifest: ExtensionManifest;
  contributions: Contribution[];
};

/** The root object produced by `loadExtensions`. */
export class ExtensionRegistry {
  readonly contributions: ContributionRegistry;
  readonly hooks: HookRegistry;
  private readonly loadedExtensions: LoadedExtension[] = [];

  constructor() {
    this.contributions = new ContributionRegistry();
    this.hooks = new HookRegistry();
  }

  /** All extensions in load order (built-ins, project, local). */
  extensions(): LoadedExtension[] {
    return [...this.loadedExtensions];
  }

  /** Record a loaded (or failed) extension. */
  addExtension(extension: LoadedExtension): void {
    this.loadedExtensions.push(extension);
  }

  /** Find a loaded extension by manifest id. */
  getExtension(id: string): LoadedExtension | undefined {
    return this.loadedExtensions.find((extension) => extension.manifest.id === id);
  }
}
