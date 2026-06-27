import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { EXCALIBUR_DIR } from '../config/load-config';

/**
 * PLAN5 — the SPRINT store: time-boxed iteration buckets for the native backlog.
 * A sprint groups work-items (each work-item's `cycleOrSprint` carries the sprint
 * id) over a `[startDate, endDate]` window, which is what a burndown is computed
 * against. Persisted one JSON file per sprint under `.excalibur/sprints/`, mirroring
 * the work-item store (per-record file, zod-on-read, `SP-<n>` ids) but using the
 * core `EXCALIBUR_DIR` constant like the other core stores.
 */

export type SprintStatus = 'planned' | 'active' | 'completed';

export interface Sprint {
  /** Stable id, e.g. `SP-3`. */
  id: string;
  name: string;
  /** The sprint goal / theme, or null. */
  goal: string | null;
  /** Inclusive window bounds as `YYYY-MM-DD`. */
  startDate: string;
  endDate: string;
  status: SprintStatus;
  /** ISO timestamp the sprint was created. */
  createdAt: string;
}

const sprintSchema = z.object({
  id: z.string(),
  name: z.string(),
  goal: z.string().nullable(),
  startDate: z.string(),
  endDate: z.string(),
  status: z.enum(['planned', 'active', 'completed']),
  createdAt: z.string(),
});

const KEY_RE = /^SP-(\d+)$/;
const keyNum = (key: string): number => {
  const m = KEY_RE.exec(key);
  return m === null ? 0 : Number.parseInt(m[1] ?? '0', 10);
};

export interface CreateSprintInput {
  name: string;
  goal?: string | null;
  /** `YYYY-MM-DD`. */
  startDate: string;
  endDate: string;
  status?: SprintStatus;
}

export interface UpdateSprintInput {
  name?: string;
  goal?: string | null;
  startDate?: string;
  endDate?: string;
  status?: SprintStatus;
}

/** A file-backed CRUD store for sprints (`.excalibur/sprints/<id>.json`). */
export class SprintStore {
  private readonly dir: string;
  private readonly now: () => Date;

  constructor(repoRoot: string, options: { now?: () => Date } = {}) {
    this.dir = join(repoRoot, EXCALIBUR_DIR, 'sprints');
    this.now = options.now ?? ((): Date => new Date());
  }

  private fileFor(id: string): string {
    // Confine the id to the `SP-<n>` shape so a crafted id can never escape the dir.
    if (!KEY_RE.test(id)) {
      throw new Error(`invalid sprint id "${id}"`);
    }
    return join(this.dir, `${id}.json`);
  }

  private readAll(): Sprint[] {
    if (!existsSync(this.dir)) {
      return [];
    }
    const sprints: Sprint[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) {
        continue;
      }
      try {
        sprints.push(sprintSchema.parse(JSON.parse(readFileSync(join(this.dir, name), 'utf8'))));
      } catch {
        // Skip a corrupt entry rather than failing the whole list.
      }
    }
    // Newest first by numeric id (SP-2 before SP-1).
    return sprints.sort((a, b) => keyNum(b.id) - keyNum(a.id));
  }

  private write(sprint: Sprint): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.fileFor(sprint.id), `${JSON.stringify(sprint, null, 2)}\n`, 'utf8');
  }

  private nextId(): string {
    let max = 0;
    for (const sprint of this.readAll()) {
      max = Math.max(max, keyNum(sprint.id));
    }
    return `SP-${max + 1}`;
  }

  /** Creates a sprint, persists it, and returns it. */
  createSprint(input: CreateSprintInput): Sprint {
    const sprint: Sprint = {
      id: this.nextId(),
      name: input.name,
      goal: input.goal ?? null,
      startDate: input.startDate,
      endDate: input.endDate,
      status: input.status ?? 'planned',
      createdAt: this.now().toISOString(),
    };
    this.write(sprint);
    return sprint;
  }

  /** All sprints, newest first. */
  listSprints(): Sprint[] {
    return this.readAll();
  }

  /** One sprint by id, or null when absent / unsafe id / corrupt. */
  getSprint(id: string): Sprint | null {
    if (!KEY_RE.test(id)) {
      return null;
    }
    const file = this.fileFor(id);
    if (!existsSync(file)) {
      return null;
    }
    try {
      return sprintSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return null;
    }
  }

  /** The currently ACTIVE sprint (newest), or null. */
  activeSprint(): Sprint | null {
    return this.readAll().find((s) => s.status === 'active') ?? null;
  }

  /** Patches a sprint (only provided keys change); returns it, or null if unknown. */
  updateSprint(id: string, patch: UpdateSprintInput): Sprint | null {
    const sprint = this.getSprint(id);
    if (sprint === null) {
      return null;
    }
    const next: Sprint = {
      ...sprint,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
      ...(patch.startDate !== undefined ? { startDate: patch.startDate } : {}),
      ...(patch.endDate !== undefined ? { endDate: patch.endDate } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    };
    this.write(next);
    return next;
  }

  /** Deletes a sprint; returns whether it existed. */
  deleteSprint(id: string): boolean {
    if (!KEY_RE.test(id)) {
      return false;
    }
    const file = this.fileFor(id);
    if (!existsSync(file)) {
      return false;
    }
    rmSync(file);
    return true;
  }
}
