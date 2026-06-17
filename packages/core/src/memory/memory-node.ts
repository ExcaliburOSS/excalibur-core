/**
 * Knowledge Compounding (plan §"Knowledge Compounding") — the project memory
 * that accumulates from runs and primes future ones, so Excalibur gets smarter
 * about a repo over time. This is the OSS slice: structured {@link MemoryNode}s
 * persisted locally and injected into the agent's effective instructions. The
 * Enterprise graph (confidence decay, contradiction, cross-team sharing) is M3+.
 */

/** What a memory node records. */
export type MemoryNodeType =
  | 'decision' // a choice that was made (and ideally why)
  | 'rejection' // an approach a human rejected — strong negative memory
  | 'risk' // a known hazard in some area
  | 'convention' // a repo-specific norm
  | 'glossary'; // a domain term's meaning

/** A node's lifecycle status (decay/supersede mature in M3+). */
export type MemoryNodeStatus = 'active' | 'superseded' | 'retired';

/**
 * One unit of project memory. `subjectPaths` (files/dirs/modules it pertains to)
 * drives retrieval — a future run touching those paths gets primed with it.
 */
export interface MemoryNode {
  id: string;
  type: MemoryNodeType;
  /** The fact, in one line (redacted — never contains secrets). */
  statement: string;
  /** Why, when known (redacted). */
  rationale?: string;
  /** Files/dirs/modules this pertains to (used for relevance matching). */
  subjectPaths: string[];
  /** The run/session that produced it, when captured from the stream. */
  sourceRunId?: string;
  /** Author (OSS: the local git user; Enterprise: the userId). */
  author?: string;
  /** 0–1; reinforced/decayed in M3+. Defaults to a sensible per-type prior. */
  confidence: number;
  /** How many times corroborated (1 at capture). */
  evidenceCount: number;
  createdAt: string;
  lastReinforcedAt: string;
  status: MemoryNodeStatus;
  /** When `status === 'superseded'`, the id of the node that replaced it. */
  supersededById?: string;
  redacted: boolean;
}

/** Input to capture a node; the store stamps id/dates/defaults and redacts. */
export interface CaptureMemoryInput {
  type: MemoryNodeType;
  statement: string;
  rationale?: string;
  subjectPaths?: string[];
  sourceRunId?: string;
  author?: string;
  /** Override the default confidence prior (0–1). */
  confidence?: number;
  /** Explicitly mark an existing node id as superseded by this capture. */
  supersedes?: string;
}

/** Default confidence prior by type — a human rejection is a strong signal. */
export const DEFAULT_CONFIDENCE: Readonly<Record<MemoryNodeType, number>> = {
  rejection: 0.9,
  decision: 0.7,
  convention: 0.7,
  risk: 0.6,
  glossary: 0.8,
};
