import { searchRepoCode, type CodeSearchHit } from '@excalibur/context-engine';
import { redactSecrets } from '@excalibur/model-gateway';
import type { AdditionalContextSource } from './effective-instructions';

/**
 * Repo-context retrieval (M2, Slice 2).
 *
 * Runs the deterministic lexical {@link searchRepoCode} over a repository and
 * formats each hit into an {@link AdditionalContextSource} the
 * EffectiveInstructionBuilder injects at precedence 6. The builder's render()
 * applies secret redaction and the per-source / total caps, so this module
 * adds NO new secret handling: it only formats already-retrieved snippets
 * (and retrieval already excludes secret-bearing files).
 */

export interface BuildRepoContextInput {
  repoRoot: string;
  query: string;
  /** Anchor file (relative POSIX path) for same-dir / imported-neighbor boosts. */
  anchorPath?: string;
  /** Total retrieval character budget for snippet text. Default 8000. */
  maxChars?: number;
  /** Maximum number of files to inject. Default 6. */
  maxFiles?: number;
}

const DEFAULT_MAX_CHARS = 8000;
const DEFAULT_MAX_FILES = 6;

/** Renders a single hit into a labeled context block. */
function formatHit(hit: CodeSearchHit, terms: string[]): string {
  const header = `[repo-context: ${hit.path} — matched: ${terms.join(', ')}]`;
  const blocks = hit.snippets.map((snippet) => {
    const range =
      snippet.startLine === snippet.endLine
        ? `line ${snippet.startLine}`
        : `lines ${snippet.startLine}-${snippet.endLine}`;
    // Defense in depth: redact at the source so a secret embedded in ordinary
    // code is masked before it is ever packaged into a context block, not only
    // when render() runs its own redaction pass downstream.
    return `(${range})\n${redactSecrets(snippet.text)}`;
  });
  return `${header}\n\n${blocks.join('\n\n')}`;
}

/**
 * Formats already-retrieved hits into context sources. Exposed so callers that
 * permission-filter hits themselves (neighbor context) can format the allowed
 * subset without re-running retrieval.
 */
export function formatHitsAsSources(
  hits: CodeSearchHit[],
  terms: string[],
): AdditionalContextSource[] {
  return hits.map((hit) => ({
    path: `repo-context: ${hit.path}`,
    title: `repo-context: ${hit.path}`,
    content: formatHit(hit, terms),
  }));
}

/**
 * Retrieves repo-context sources for a query. Returns `[]` when no files match
 * (retrieval is best-effort and never throws on a missing/unreadable repo).
 */
export async function buildRepoContextSources(
  input: BuildRepoContextInput,
): Promise<AdditionalContextSource[]> {
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
  const totalCharBudget = input.maxChars ?? DEFAULT_MAX_CHARS;

  const result = await searchRepoCode(input.repoRoot, {
    query: input.query,
    maxFiles,
    totalCharBudget,
    ...(input.anchorPath !== undefined ? { anchorPath: input.anchorPath } : {}),
  });

  if (result.hits.length === 0) {
    return [];
  }

  return formatHitsAsSources(result.hits, result.terms);
}
