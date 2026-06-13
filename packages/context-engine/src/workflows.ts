import type { DetectedStack, RepoPatterns } from './types';

/**
 * Suggests built-in workflows based on detected patterns. Deterministic and
 * always non-empty: every repository can run `fast-fix` and
 * `standard-feature`; riskier areas add the matching guarded workflows.
 */
export function suggestWorkflows(stack: DetectedStack, patterns: RepoPatterns): string[] {
  const suggestions: string[] = ['fast-fix', 'standard-feature'];
  const add = (workflowId: string): void => {
    if (!suggestions.includes(workflowId)) {
      suggestions.push(workflowId);
    }
  };

  if (patterns.testDirs.length > 0) {
    add('safe-refactor');
  }
  if (patterns.migrationDirs.length > 0) {
    add('migration');
  }
  if (patterns.sensitivePaths.length > 0) {
    add('security-review');
  }
  if (patterns.hasBackend && patterns.hasFrontend) {
    add('structured-feature');
  }
  return suggestions;
}
