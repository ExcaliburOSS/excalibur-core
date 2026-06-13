/**
 * Minimal logger surface handed to extensions (Build Contract §4.6d).
 *
 * The SDK never prints by itself — packages must not use `console.log`
 * (Contract §2.5) — so the default logger is a silent no-op. The host (CLI or
 * Enterprise runtime) injects a real logger when it creates the context.
 */
export interface ExtensionLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** Configuration values resolved for an extension by the host. */
export type ExtensionConfig = Record<string, unknown>;

/** Silent logger used when the host does not provide one. */
export function createNoopLogger(): ExtensionLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}
