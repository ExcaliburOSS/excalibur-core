import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ArtifactRecordError } from '../errors';
import { EXCALIBUR_DIR } from '../config/load-config';
import {
  appendLineEnsured,
  listSubdirectories,
  readTextIfExists,
  reserveTimestampDir,
  writeFileEnsured,
} from '../internal/fs-utils';

/**
 * Local conversational sessions (M-Shell Slice A): the on-disk record of an
 * interactive `excalibur` REPL session, mirroring the `LocalArtifactStore` /
 * `DiscoveryManager` conventions.
 *
 * - `.excalibur/sessions/<sess_YYYYMMDD_HHMMSS>/metadata.json` — a
 *   schema-validated {@link SessionMetadata} record.
 * - `.excalibur/sessions/<sess_YYYYMMDD_HHMMSS>/transcript.jsonl` — one
 *   {@link SessionTurn} per line, appended via `appendLineEnsured`.
 * - `.excalibur/sessions/history` — newline-delimited submitted prompts
 *   (per-repo prompt history) used to seed the readline editor.
 *
 * Surface-agnostic: this store never touches readline, console or any Ui. The
 * CLI REPL (and the future Ink surface) drive it.
 */

export const sessionTurnRoleSchema = z.enum(['user', 'assistant', 'system']);
export type SessionTurnRole = z.infer<typeof sessionTurnRoleSchema>;

export const sessionTurnKindSchema = z.enum(['message', 'route', 'approval', 'status']);
export type SessionTurnKind = z.infer<typeof sessionTurnKindSchema>;

export const sessionStatusSchema = z.enum(['active', 'closed']);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/** A single recorded turn in the conversation transcript. */
export const sessionTurnSchema = z.object({
  /** Stable id `<sessionId>:<seq>`. */
  id: z.string().min(1),
  /** Monotonic per-session sequence number (0-based). */
  seq: z.number().int().nonnegative(),
  role: sessionTurnRoleSchema,
  kind: sessionTurnKindSchema,
  text: z.string(),
  /** The route decision (lane/intent) for `kind: 'route'` turns. */
  route: z.string().optional(),
  /** Reference to a produced artifact (run id, interaction id, discovery id). */
  artifactRef: z.string().optional(),
  /** Model that produced an assistant turn. */
  model: z.string().optional(),
  /** Cost of an assistant turn, in cents. */
  costCents: z.number().nullable().optional(),
  at: z.string().datetime({ offset: true }),
});
export type SessionTurn = z.infer<typeof sessionTurnSchema>;

/** `metadata.json` for a session directory. */
export const sessionMetadataSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  repoRoot: z.string(),
  /** Provider/model that last answered in this session (null until first turn). */
  lastModel: z.string().nullable(),
  turnCount: z.number().int().nonnegative(),
  status: sessionStatusSchema,
});
export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

/** A loaded session: its metadata plus the directory it lives in. */
export interface LocalSession {
  id: string;
  dir: string;
  metadata: SessionMetadata;
}

export interface CreateSessionInput {
  /** A human title for the session (defaults to a timestamped label). */
  title?: string;
  /** Repository root the session belongs to (recorded in metadata). */
  repoRoot?: string;
}

/** A turn to append; `seq`, `id` and `at` are filled in by the store. */
export interface AppendTurnInput {
  role: SessionTurnRole;
  kind: SessionTurnKind;
  text: string;
  route?: string;
  artifactRef?: string;
  model?: string;
  costCents?: number | null;
  /** Override the timestamp (tests); defaults to now. */
  at?: string;
}

const METADATA_FILE = 'metadata.json';
const TRANSCRIPT_FILE = 'transcript.jsonl';
const HISTORY_FILE = 'history';

/** Prompt-history cap: how many recent submitted prompts to retain. */
export const PROMPT_HISTORY_CAP = 500;

/**
 * `SessionStore(repoRoot)` over `.excalibur/sessions/` — the persistence layer
 * for interactive REPL sessions and the per-repo prompt history.
 */
export class SessionStore {
  readonly repoRoot: string;
  private readonly baseDir: string;
  private readonly historyPath: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
    this.baseDir = join(repoRoot, EXCALIBUR_DIR, 'sessions');
    this.historyPath = join(this.baseDir, HISTORY_FILE);
  }

  /** Creates a fresh session directory + metadata.json + empty transcript. */
  createSession(input: CreateSessionInput = {}): LocalSession {
    const { id, dir } = reserveTimestampDir(this.baseDir, 'sess');
    const now = new Date().toISOString();
    const metadata: SessionMetadata = {
      id,
      title: input.title ?? `Session ${id}`,
      createdAt: now,
      updatedAt: now,
      repoRoot: input.repoRoot ?? this.repoRoot,
      lastModel: null,
      turnCount: 0,
      status: 'active',
    };
    this.writeMetadata(dir, metadata);
    // Touch the transcript so a brand-new session always has the file.
    writeFileEnsured(join(dir, TRANSCRIPT_FILE), '');
    return { id, dir, metadata };
  }

  /** Appends a turn to the transcript and bumps `turnCount`/`updatedAt`. */
  appendTurn(id: string, turn: AppendTurnInput): SessionTurn {
    const session = this.getSession(id);
    const seq = session.metadata.turnCount;
    const entry: SessionTurn = sessionTurnSchema.parse({
      id: `${id}:${seq}`,
      seq,
      role: turn.role,
      kind: turn.kind,
      text: turn.text,
      ...(turn.route !== undefined ? { route: turn.route } : {}),
      ...(turn.artifactRef !== undefined ? { artifactRef: turn.artifactRef } : {}),
      ...(turn.model !== undefined ? { model: turn.model } : {}),
      ...(turn.costCents !== undefined ? { costCents: turn.costCents } : {}),
      at: turn.at ?? new Date().toISOString(),
    });
    appendLineEnsured(join(session.dir, TRANSCRIPT_FILE), JSON.stringify(entry));
    this.updateMetadata(id, {
      turnCount: seq + 1,
      ...(turn.model !== undefined ? { lastModel: turn.model } : {}),
    });
    return entry;
  }

  /** Reads every turn of a session's transcript (tolerant of corrupt lines). */
  readTranscript(id: string): SessionTurn[] {
    const session = this.getSession(id);
    const raw = readTextIfExists(join(session.dir, TRANSCRIPT_FILE));
    if (raw === null) {
      return [];
    }
    const turns: SessionTurn[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // a corrupt line never breaks transcript replay
      }
      const result = sessionTurnSchema.safeParse(parsed);
      if (result.success) {
        turns.push(result.data);
      }
    }
    return turns;
  }

  getSession(id: string): LocalSession {
    const dir = join(this.baseDir, id);
    if (!existsSync(join(dir, METADATA_FILE))) {
      throw new ArtifactRecordError(`Session "${id}" was not found under ${this.baseDir}.`, { id });
    }
    return { id, dir, metadata: this.readMetadata(dir) };
  }

  /** Lists every session, newest last (tolerant of corrupt entries). */
  listSessions(): LocalSession[] {
    const sessions: LocalSession[] = [];
    for (const name of listSubdirectories(this.baseDir)) {
      const dir = join(this.baseDir, name);
      try {
        sessions.push({ id: name, dir, metadata: this.readMetadata(dir) });
      } catch {
        // Tolerant listing: a corrupt session never breaks `--continue`.
      }
    }
    return sessions;
  }

  /** The most-recently-created session, or `null` when there are none. */
  latestSession(): LocalSession | null {
    const sessions = this.listSessions();
    // ids are `sess_YYYYMMDD_HHMMSS`, sorted lexicographically == chronologically.
    return sessions.length > 0 ? (sessions[sessions.length - 1] as LocalSession) : null;
  }

  /** Merges a metadata patch (e.g. status/title changes) and persists it. */
  updateMetadata(id: string, patch: Partial<SessionMetadata>): LocalSession {
    const existing = this.getSession(id);
    const merged = sessionMetadataSchema.parse({
      ...existing.metadata,
      ...patch,
      id,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    });
    this.writeMetadata(existing.dir, merged);
    return { id, dir: existing.dir, metadata: merged };
  }

  // --- prompt history ----------------------------------------------------------

  /**
   * Loads the per-repo prompt history (oldest first), capped at
   * {@link PROMPT_HISTORY_CAP} lines. Used to seed the readline editor.
   */
  loadPromptHistory(): string[] {
    const raw = readTextIfExists(this.historyPath);
    if (raw === null) {
      return [];
    }
    const lines = raw.split('\n').filter((line) => line.length > 0);
    return lines.slice(-PROMPT_HISTORY_CAP);
  }

  /**
   * Appends a submitted prompt to the per-repo history. Skips empties and
   * adjacent duplicates; rewrites the file when the cap would be exceeded.
   */
  appendPromptHistory(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    const existing = this.loadPromptHistory();
    if (existing.length > 0 && existing[existing.length - 1] === trimmed) {
      return; // dedupe-adjacent
    }
    const next = [...existing, trimmed].slice(-PROMPT_HISTORY_CAP);
    if (next.length > existing.length && next.length < PROMPT_HISTORY_CAP) {
      // Common, non-truncating case: a cheap append.
      appendLineEnsured(this.historyPath, trimmed);
    } else {
      // Truncating or dedupe-after-cap: rewrite the whole capped file.
      writeFileEnsured(this.historyPath, next.length > 0 ? `${next.join('\n')}\n` : '');
    }
    this.restrictHistoryPerms();
  }

  /**
   * Restricts the prompt-history file to owner-only (0600): on a shared machine
   * a user's prompts (a personal/sensitive signal) must not be world-readable.
   * Best-effort — silently ignored on filesystems that don't support chmod.
   */
  private restrictHistoryPerms(): void {
    try {
      chmodSync(this.historyPath, 0o600);
    } catch {
      // Windows / certain mounts don't support POSIX perms — ignore.
    }
  }

  // --- persistence -------------------------------------------------------------

  private writeMetadata(dir: string, metadata: SessionMetadata): void {
    writeFileEnsured(join(dir, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`);
  }

  private readMetadata(dir: string): SessionMetadata {
    const raw = readTextIfExists(join(dir, METADATA_FILE));
    if (raw === null) {
      throw new ArtifactRecordError(`Missing ${METADATA_FILE} in ${dir}.`, { dir });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ArtifactRecordError(`${METADATA_FILE} in ${dir} is not valid JSON: ${reason}`, {
        dir,
      });
    }
    const result = sessionMetadataSchema.safeParse(parsed);
    if (!result.success) {
      const problems = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new ArtifactRecordError(`Invalid ${METADATA_FILE} in ${dir}: ${problems}`, { dir });
    }
    return result.data;
  }
}
