import { ExcaliburError } from '@excalibur/shared';

/**
 * Thrown when repository analysis cannot run at all (e.g. the target
 * directory does not exist or is not a directory). Individual unreadable
 * files never throw — they are skipped so analysis stays best-effort.
 */
export class RepoAnalysisError extends ExcaliburError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'repo_analysis', details);
  }
}
