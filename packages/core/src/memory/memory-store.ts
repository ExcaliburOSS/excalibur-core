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

  /** Captures a node: redacts, stamps id/dates/defaults, appends to the JSONL. */
  capture(input: CaptureMemoryInput): MemoryNode {
    const createdAt = this.now();
    const base: Omit<MemoryNode, 'id'> = {
      type: input.type,
      statement: redactSecrets(input.statement.trim()),
      ...(input.rationale !== undefined ? { rationale: redactSecrets(input.rationale.trim()) } : {}),
      subjectPaths: (input.subjectPaths ?? []).map((p) => p.trim()).filter((p) => p.length > 0),
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
    return node;
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
    const scored = this.all()
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
