/**
 * Excalibur error hierarchy (Build Contract §4.1).
 *
 * Every error thrown by an Excalibur package must be an `ExcaliburError`
 * subclass so that the CLI and Enterprise ingestion can rely on a stable,
 * machine-readable `code` plus optional structured `details`.
 */
export class ExcaliburError extends Error {
  /** Stable machine-readable error code (snake_case). */
  readonly code: string;
  /** Optional structured context for diagnostics; never include secrets. */
  readonly details?: Record<string, unknown>;

  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
    // Restore the prototype chain for ES5/CJS interop targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when `.excalibur/config.yaml` (or a providers file) fails validation. */
export class ConfigValidationError extends ExcaliburError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'config_validation', details);
  }
}

/** Thrown when a workflow or methodology definition fails validation. */
export class WorkflowValidationError extends ExcaliburError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'workflow_validation', details);
  }
}

/** Thrown when a path, command or tool operation is denied by permissions. */
export class PermissionDeniedError extends ExcaliburError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'permission_denied', details);
  }
}

/**
 * Thrown by model providers and sync clients. The default code is
 * `provider_error`; callers may narrow it (e.g. `provider_not_implemented`,
 * `sync_failed`) through `options.code`.
 */
export class ProviderError extends ExcaliburError {
  constructor(message: string, options?: { code?: string; details?: Record<string, unknown> }) {
    super(message, options?.code ?? 'provider_error', options?.details);
  }
}

/** Thrown when a run id does not resolve to a local run directory. */
export class RunNotFoundError extends ExcaliburError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'run_not_found', details);
  }
}

/** Thrown when an `@excalibur` command mention cannot be parsed. */
export class CommandParseError extends ExcaliburError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'command_parse', details);
  }
}

/** Narrowing helper for `catch (error: unknown)` blocks. */
export function isExcaliburError(value: unknown): value is ExcaliburError {
  return value instanceof ExcaliburError;
}
