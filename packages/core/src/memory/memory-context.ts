import type { AdditionalContextSource } from '../instructions/effective-instructions';
import { MemoryStore, type RetrieveOptions } from './memory-store';
import type { MemoryNode } from './memory-node';

/**
 * Turns retrieved {@link MemoryNode}s into an {@link AdditionalContextSource} for
 * the {@link EffectiveInstructionBuilder} — the channel that already injects
 * repo context into the agent's effective instructions. Memory sits at the
 * repo-context precedence (it informs, never overrides policy/config/AGENTS.md).
 * Returns `null` when there is nothing relevant, so an unrelated turn is
 * untouched.
 */
export function memoryContextSource(
  nodes: ReadonlyArray<MemoryNode>,
): AdditionalContextSource | null {
  if (nodes.length === 0) {
    return null;
  }
  const lines = nodes.map((node) => {
    const where = node.subjectPaths.length > 0 ? `  (${node.subjectPaths.join(', ')})` : '';
    const why =
      node.rationale !== undefined && node.rationale.length > 0 ? ` — ${node.rationale}` : '';
    return `- [${node.type}] ${node.statement}${why}${where}`;
  });
  const content =
    'Prior decisions, rejections, risks and conventions Excalibur recorded for this repository. ' +
    'Respect them; if you must contradict one, say so explicitly and explain why.\n\n' +
    lines.join('\n');
  return {
    path: '.excalibur/memory',
    title: 'Project memory (compounded)',
    content,
    precedence: 6,
  };
}

/**
 * Convenience: retrieve the most relevant memory for `queryPaths` and format it
 * as a context source in one call. Best-effort — a read failure yields `null`
 * (memory never blocks a turn).
 */
export function buildMemoryContext(
  repoRoot: string,
  queryPaths: ReadonlyArray<string>,
  options: RetrieveOptions = {},
): AdditionalContextSource | null {
  try {
    const nodes = new MemoryStore(repoRoot).retrieve(queryPaths, options);
    return memoryContextSource(nodes);
  } catch {
    return null;
  }
}
