import type { GuardResult, UntrustedSource } from './content-guard';

/**
 * Provenance record (F8) for one piece of untrusted inbound content: where it
 * came from, when, its content hash, and the injection verdict. Emitted as a
 * `provenance` event so a run has a verifiable, auditable trail of every external
 * source the model saw (and whether it was flagged). Pure.
 */
export interface ProvenanceRecord {
  source: UntrustedSource;
  url?: string;
  /** sha256 of the original fetched content. */
  contentHash: string;
  fetchedAt: string;
  verdict: GuardResult['verdict'];
  /** Signal categories that fired (empty when clean). */
  signals: string[];
  /** True when the content was quarantined out of the model context. */
  blocked: boolean;
}

export function buildProvenanceRecord(
  source: UntrustedSource,
  url: string | undefined,
  guard: GuardResult,
  fetchedAt: string,
): ProvenanceRecord {
  return {
    source,
    ...(url !== undefined && url.length > 0 ? { url } : {}),
    contentHash: guard.contentHash,
    fetchedAt,
    verdict: guard.verdict,
    signals: guard.signals.map((s) => s.category),
    blocked: guard.blocked,
  };
}
