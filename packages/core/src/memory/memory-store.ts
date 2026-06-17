import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactSecrets } from '@excalibur/model-gateway';
import { EXCALIBUR_DIR } from '../config/load-config';
import {
  DEFAULT_CONFIDENCE,
  type CaptureMemoryInput,
  type MemoryNode,
} from './memory-node';

/**
 * Local Knowledge-Compounding store (OSS slice): structured {@link MemoryNode}s
 * persisted as JSONL at `.excalibur/memory/nodes.jsonl` — append-only, the
 * lossless source of truth. Capture redacts secrets; retrieval ranks by
 * subject-path relevance × confidence × recency so a run touching given paths is
 * primed with the most pertinent prior decisions. Confidence decay/contradiction
 * and the multi-user graph are Enterprise / M3+.
 */

const NODES_FILE = join('memory', 'nodes.jsonl');

/** Injectable clock/id for deterministic tests. */
export interface MemoryStoreOptions {
  now?: () => string;
  idFor?: (node: Omit<MemoryNode, 'id'>) => string;
}

/** Options for {@link MemoryStore.retrieve}. */
export interface RetrieveOptions {
  /** Max nodes to return (default 5). */
  limit?: number;
  /** Restrict to a node type. */
  type?: MemoryNode['type'];
  /** ISO `now` for recency scoring (defaults to the store's clock). */
  now?: string;
}

export class MemoryStore {
  private readonly path: string;
  private readonly now: () => string;
  private readonly idFor: (node: Omit<MemoryNode, 'id'>) => string;

  constructor(repoRoot: string, options: MemoryStoreOptions = {}) {
    this.path = join(repoRoot, EXCALIBUR_DIR, NODES_FILE);
    this.now = options.now ?? ((): string => new Date().toISOString());
    this.idFor =
      options.idFor ??
      ((node): string => `mem_${node.createdAt.replace(/[^0-9]/g, '').slice(0, 14)}_${shortHash(node.statement)}`);
  }

  /**
   * Captures a node — the KNOWLEDGE-COMPOUNDING entry point (plan P2.12). Before
   * adding it, it folds it against the current memory:
   *  - **Corroboration** — a matching active node of the SAME type (overlapping
   *    subjectPaths + similar statement) is REINFORCED (evidenceCount++, confidence
   *    rises with diminishing returns) instead of duplicated; the reinforced node
   *    is returned.
   *  - **Supersede-on-contradiction** — an explicit `supersedes`, OR a `rejection`
   *    that matches a prior active `decision`/`convention` on overlapping paths,
   *    marks the older node `superseded` (linked via `supersededById`, confidence
   *    halved) so a since-reversed belief stops priming future runs.
   * All of this is APPEND-ONLY (each change is a new revision line; {@link current}
   * collapses by id), so the JSONL stays the lossless source of truth.
   */
  capture(input: CaptureMemoryInput): MemoryNode {
    const createdAt = this.now();
    const statement = redactSecrets(input.statement.trim());
    const subjectPaths = (input.subjectPaths ?? []).map((p) => p.trim()).filter((p) => p.length > 0);

    // Corroboration: reinforce an existing equivalent node rather than duplicate.
    // Skipped when the caller explicitly supersedes (they want a distinct node).
    const current = this.current();
    const match =
      input.supersedes !== undefined
        ? undefined
        : current.find(
            (node) =>
              node.status === 'active' &&
              node.type === input.type &&
              subjectsOverlap(node.subjectPaths, subjectPaths) &&
              statementSimilarity(node.statement, statement) >= REINFORCE_THRESHOLD,
          );
    if (match !== undefined) {
      return this.appendRevision({
        ...match,
        evidenceCount: match.evidenceCount + 1,
        confidence: reinforcedConfidence(match.confidence),
        lastReinforcedAt: createdAt,
      });
    }

    const base: Omit<MemoryNode, 'id'> = {
      type: input.type,
      statement,
      ...(input.rationale !== undefined ? { rationale: redactSecrets(input.rationale.trim()) } : {}),
      subjectPaths,
      ...(input.sourceRunId !== undefined ? { sourceRunId: input.sourceRunId } : {}),
      ...(input.author !== undefined ? { author: input.author } : {}),
      confidence: clamp01(input.confidence ?? DEFAULT_CONFIDENCE[input.type]),
      evidenceCount: 1,
      createdAt,
      lastReinforcedAt: createdAt,
      status: 'active',
      redacted: true,
    };
    const node: MemoryNode = { ...base, id: this.idFor(base) };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(node)}\n`, 'utf8');

    // Supersede-on-contradiction: an explicit target, or a rejection that lands
    // on a prior decision/convention about the same subject.
    const toSupersede = current.filter((node) => {
      if (node.status !== 'active') return false;
      if (input.supersedes !== undefined && node.id === input.supersedes) return true;
      if (input.type !== 'rejection') return false;
      if ((node.type !== 'decision' && node.type !== 'convention')) return false;
      if (!subjectsOverlap(node.subjectPaths, subjectPaths)) return false;
      return statementSimilarity(node.statement, statement) >= CONTRADICT_THRESHOLD;
    });
    for (const old of toSupersede) {
      this.appendRevision({
        ...old,
        status: 'superseded',
        supersededById: node.id,
        confidence: clamp01(old.confidence * 0.5),
        lastReinforcedAt: createdAt,
      });
    }

    return node;
  }

  /** Appends a new revision of an existing node (same id) and returns it. */
  private appendRevision(node: MemoryNode): MemoryNode {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(node)}\n`, 'utf8');
    return node;
  }

  /**
   * The CURRENT state of memory: the latest revision per id (append-only history
   * collapsed). Reinforcements and supersessions are later revisions of the same
   * id, so the last line wins.
   */
  current(): MemoryNode[] {
    const byId = new Map<string, MemoryNode>();
    for (const node of this.all()) {
      byId.set(node.id, node); // later lines overwrite → latest revision wins
    }
    return [...byId.values()];
  }

  /** All persisted nodes (newest last). Malformed lines are skipped, never thrown. */
  all(): MemoryNode[] {
    if (!existsSync(this.path)) {
      return [];
    }
    const nodes: MemoryNode[] = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        nodes.push(JSON.parse(trimmed) as MemoryNode);
      } catch {
        /* tolerate a corrupt line rather than lose the whole memory */
      }
    }
    return nodes;
  }

  /**
   * The active nodes most relevant to `queryPaths`, ranked by
   * `relevance × confidence × recency`. Only nodes that actually relate to a
   * query path are returned (relevance > 0), so an unrelated run is not polluted.
   */
  retrieve(queryPaths: ReadonlyArray<string>, options: RetrieveOptions = {}): MemoryNode[] {
    const limit = options.limit ?? 5;
    const nowMs = Date.parse(options.now ?? this.now());
    const scored = this.current()
      .filter((node) => node.status === 'active')
      .filter((node) => options.type === undefined || node.type === options.type)
      .map((node) => ({ node, score: this.scoreNode(node, queryPaths, nowMs) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((entry) => entry.node);
  }

  private scoreNode(node: MemoryNode, queryPaths: ReadonlyArray<string>, nowMs: number): number {
    const relevance = node.subjectPaths.reduce(
      (sum, subject) => sum + (queryPaths.some((q) => pathsRelate(subject, q)) ? 1 : 0),
      0,
    );
    if (relevance === 0) {
      return 0;
    }
    const ageDays = Math.max(0, (nowMs - Date.parse(node.createdAt)) / 86_400_000);
    const recency = 1 / (1 + ageDays / 30); // ~half-weight at one month old
    return relevance * node.confidence * recency;
  }
}

/** Statement similarity at/above which a same-type capture REINFORCES (not duplicates). */
const REINFORCE_THRESHOLD = 0.6;
/** Similarity at/above which a rejection CONTRADICTS a prior decision/convention. */
const CONTRADICT_THRESHOLD = 0.4;

/** Confidence after one corroboration — rises toward 1 with diminishing returns. */
function reinforcedConfidence(current: number): number {
  return clamp01(current + (1 - current) * 0.34);
}

/**
 * Do two subject-path sets overlap STRICTLY ENOUGH for a DESTRUCTIVE compounding
 * op (reinforce/supersede)? Used only by capture(); retrieve() scoring uses the
 * looser {@link pathsRelate} prefix match. Strict because reinforce merges nodes
 * and supersede retires them:
 *  - an UNSCOPED node (empty paths) never matches — "paths unknown" is NOT "both
 *    global", so path-less captures don't all collapse/retire each other (#12);
 *  - matching requires an EXACTLY-equal normalized path, so a broad ancestor
 *    (`src/billing`) can't wildcard-supersede a narrow file (`src/billing/x.ts`) (#13).
 */
function subjectsOverlap(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length === 0 || b.length === 0) {
    return false;
  }
  const nb = new Set(b.map(normalizePath));
  return a.some((x) => nb.has(normalizePath(x)));
}

/** Lowercased alphanumeric tokens (length ≥ 3) of a statement, for similarity. */
function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3),
  );
}

/** Token-set Jaccard similarity of two statements (0–1; deterministic). */
function statementSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) {
    return a.trim() === b.trim() ? 1 : 0;
  }
  let intersection = 0;
  for (const t of ta) {
    if (tb.has(t)) intersection += 1;
  }
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Two paths relate when one contains the other (exact or directory prefix). */
function pathsRelate(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (na.length === 0 || nb.length === 0) {
    return false;
  }
  return na === nb || na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`);
}

function normalizePath(p: string): string {
  return p.trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** A short, stable hash of a string (for node ids). */
function shortHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36).slice(0, 8);
}
