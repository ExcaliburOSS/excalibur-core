import { createHash } from 'node:crypto';

/**
 * Provenance + citation records for the native research pipeline (F7). Every
 * fetched source carries its URL, the time it was read, and a content hash, so
 * a synthesized answer can cite verifiable, timestamped sources (and F8's
 * provenance ledger can consume the same record). Pure — no I/O.
 */

export interface CitedSource {
  url: string;
  title: string;
  /** ISO timestamp the source was fetched. */
  fetchedAt: string;
  /** sha256 of the fetched markdown (content fingerprint). */
  sha256: string;
  /** The fetched markdown (may be excerpted by the caller). */
  markdown: string;
}

/** sha256 hex of `text` (content fingerprint for provenance). */
export function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Builds a {@link CitedSource}, stamping the content hash. */
export function makeCitedSource(
  url: string,
  title: string,
  markdown: string,
  fetchedAt: string,
): CitedSource {
  return {
    url,
    title: title.length > 0 ? title : url,
    fetchedAt,
    sha256: hashContent(markdown),
    markdown,
  };
}

/** Renders a numbered, verifiable source list (`[n] title — url (fetched …, sha256 …)`). */
export function formatCitations(sources: ReadonlyArray<CitedSource>): string {
  return sources
    .map(
      (s, i) =>
        `[${i + 1}] ${s.title} — ${s.url} (fetched ${s.fetchedAt}, sha256 ${s.sha256.slice(0, 12)})`,
    )
    .join('\n');
}

/** Assembles the full cited report: question → answer → numbered sources. */
export function renderCitedReport(
  question: string,
  answer: string,
  sources: ReadonlyArray<CitedSource>,
): string {
  const cites = sources.length > 0 ? `\n\n## Sources\n${formatCitations(sources)}` : '';
  return `# Research: ${question}\n\n${answer}${cites}`;
}
