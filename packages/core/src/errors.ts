import { ExcaliburError } from '@excalibur/shared';

/**
 * Core-local error subclasses. The shared package owns the contract-pinned
 * hierarchy (ConfigValidationError, RunNotFoundError, …); these add codes for
 * failure modes specific to `@excalibur/core` (git plumbing, local artifact
 * stores, discovery sessions).
 */

/** Thrown when a real git operation (branch creation, log, …) fails. */
export class GitOperationError extends ExcaliburError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'git_operation', details);
  }
}

/** Thrown when a patch id does not resolve to a local patch directory. */
export class PatchNotFoundError extends ExcaliburError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'patch_not_found', details);
  }
}

/** Thrown when an interaction id does not resolve to a local directory. */
export class InteractionNotFoundError extends ExcaliburError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'interaction_not_found', details);
  }
}

/** Thrown when a discovery session id does not resolve to a local session. */
export class DiscoverySessionNotFoundError extends ExcaliburError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'discovery_not_found', details);
  }
}

/** Thrown when a stored record (run.json, metadata.json, …) is corrupted. */
export class ArtifactRecordError extends ExcaliburError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'artifact_record_invalid', details);
  }
}
