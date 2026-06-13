/**
 * Custom context source contract (extensions-spec.md §5).
 *
 * Context sources let extensions feed external knowledge (wikis, docs sites,
 * issue trackers, vector stores, …) into prompt assembly. M1 does not query
 * extension context sources inside runs yet; the interface is the stable
 * surface extensions code against.
 */

/** Input for a free-text search across a context source. */
export interface ContextSearchInput {
  query: string;
  /** Maximum number of documents to return. */
  limit?: number;
  /** Provider-specific filters (space, project, label, …). */
  filters?: Record<string, unknown>;
}

/** Input for loading one document by its source-native id. */
export interface ContextLoadInput {
  /** Source-native document identifier (as returned in `ContextDocument.id`). */
  documentId: string;
}

/** A document returned by a context source. */
export interface ContextDocument {
  /** Source-native document identifier. */
  id: string;
  title: string;
  /** Document body as markdown or plain text. */
  content: string;
  /** Canonical URL of the document, when one exists. */
  uri?: string;
  /** Id of the `ContextSource` that produced the document. */
  sourceId?: string;
  /** Relevance score for search results (higher is more relevant). */
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface ContextSource {
  /** Stable source id (e.g. `confluence`, `notion-handbook`). */
  id: string;
  /** Human-readable source name. */
  name: string;
  search(input: ContextSearchInput): Promise<ContextDocument[]>;
  load(input: ContextLoadInput): Promise<ContextDocument>;
}
