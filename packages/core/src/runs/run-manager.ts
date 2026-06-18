import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseEventsJsonl,
  RunNotFoundError,
  runRecordSchema,
  serializeEventLine,
  type AutonomyLevel,
  type ExcaliburEvent,
  type ExecutionStyle,
  type LocalRun,
  type RunRecord,
} from '@excalibur/shared';
import { EXCALIBUR_DIR } from '../config/load-config';
import { ArtifactRecordError } from '../errors';
import {
  appendLineEnsured,
  listSubdirectories,
  readTextIfExists,
  reserveTimestampDir,
  writeFileEnsured,
} from '../internal/fs-utils';

/** Input for `RunManager.createRun` (Build Contract §4.6). */
export interface CreateRunInput {
  title: string;
  autonomyLevel: AutonomyLevel;
  workflow: string;
  methodology?: string | null;
  model?: string | null;
  executionStyle?: ExecutionStyle | null;
}

/** One `model-calls.jsonl` line (Build Contract §6). */
export interface ModelCallLine {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number | null;
  timestamp: string;
}

const RUN_RECORD_FILE = 'run.json';
const EVENTS_FILE = 'events.jsonl';
const MODEL_CALLS_FILE = 'model-calls.jsonl';

/**
 * Local run store (Build Contract §4.6, OSS spec §11): every run lives in
 * `.excalibur/runs/<run_YYYYMMDD_HHMMSS>/` with a `run.json` record, an
 * `events.jsonl` event log and the artifact files its workflow produces.
 */
export class RunManager {
  readonly repoRoot: string;
  private readonly runsDir: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
    this.runsDir = join(repoRoot, EXCALIBUR_DIR, 'runs');
  }

  createRun(input: CreateRunInput): LocalRun {
    const startedAt = new Date();
    // Reserve the run directory atomically so two instances starting a run in
    // the same repo and second can never collide (closes the check-then-write
    // race); the second is bumped on EEXIST, keeping ids chronologically sorted.
    const { id, dir } = reserveTimestampDir(this.runsDir, 'run', startedAt);

    const record: RunRecord = {
      id,
      title: input.title,
      autonomyLevel: input.autonomyLevel,
      workflow: input.workflow,
      methodology: input.methodology ?? null,
      status: 'queued',
      model: input.model ?? null,
      executionStyle: input.executionStyle ?? null,
      startedAt: startedAt.toISOString(),
      completedAt: null,
    };

    this.writeRecord(dir, record);
    return { id, dir, record };
  }

  appendEvent(runId: string, event: ExcaliburEvent): void {
    const dir = this.dirFor(runId);
    appendLineEnsured(join(dir, EVENTS_FILE), serializeEventLine(event));
  }

  /** Appends one `model-calls.jsonl` line (Build Contract §6). */
  appendModelCall(runId: string, call: ModelCallLine): void {
    const dir = this.dirFor(runId);
    appendLineEnsured(join(dir, MODEL_CALLS_FILE), JSON.stringify(call));
  }

  /** Writes an artifact file into the run directory; returns its absolute path. */
  writeArtifact(runId: string, fileName: string, content: string): string {
    const dir = this.dirFor(runId);
    const filePath = join(dir, fileName);
    writeFileEnsured(filePath, content);
    return filePath;
  }

  updateRecord(runId: string, patch: Partial<RunRecord>): RunRecord {
    const run = this.getRun(runId);
    const updated = this.validateRecord({ ...run.record, ...patch, id: run.id }, run.dir);
    this.writeRecord(run.dir, updated);
    return updated;
  }

  getRun(runId: string): LocalRun {
    const dir = this.dirFor(runId);
    const record = this.readRecord(dir, runId);
    return { id: runId, dir, record };
  }

  /** All local runs, sorted by id (= chronological for timestamp ids). */
  listRuns(): LocalRun[] {
    const runs: LocalRun[] = [];
    for (const name of listSubdirectories(this.runsDir)) {
      const dir = join(this.runsDir, name);
      try {
        runs.push({ id: name, dir, record: this.readRecord(dir, name) });
      } catch {
        // Tolerant listing: a corrupted run directory never breaks `status`.
      }
    }
    return runs;
  }

  latestRun(): LocalRun | null {
    const runs = this.listRuns();
    return runs.length > 0 ? (runs[runs.length - 1] ?? null) : null;
  }

  readEvents(runId: string): ExcaliburEvent[] {
    const dir = this.dirFor(runId);
    const content = readTextIfExists(join(dir, EVENTS_FILE));
    return content === null ? [] : parseEventsJsonl(content);
  }

  /** Absolute path to a run's `events.jsonl` (for an incremental tail/stream). */
  eventsPath(runId: string): string {
    return join(this.dirFor(runId), EVENTS_FILE);
  }

  /** Parsed `model-calls.jsonl` lines (cost/token ledger). Tolerant: skips bad lines. */
  readModelCalls(runId: string): ModelCallLine[] {
    const dir = this.dirFor(runId);
    const content = readTextIfExists(join(dir, MODEL_CALLS_FILE));
    if (content === null) {
      return [];
    }
    const calls: ModelCallLine[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        calls.push(JSON.parse(trimmed) as ModelCallLine);
      } catch {
        // tolerant: a truncated last line never breaks insights
      }
    }
    return calls;
  }

  // --- internals -------------------------------------------------------------

  private dirFor(runId: string): string {
    const dir = join(this.runsDir, runId);
    if (!existsSync(join(dir, RUN_RECORD_FILE))) {
      throw new RunNotFoundError(`Run "${runId}" was not found under ${this.runsDir}.`, {
        runId,
        runsDir: this.runsDir,
      });
    }
    return dir;
  }

  private writeRecord(dir: string, record: RunRecord): void {
    writeFileEnsured(join(dir, RUN_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
  }

  private readRecord(dir: string, runId: string): RunRecord {
    const raw = readTextIfExists(join(dir, RUN_RECORD_FILE));
    if (raw === null) {
      throw new RunNotFoundError(`Run "${runId}" has no run.json in ${dir}.`, { runId, dir });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ArtifactRecordError(`run.json of "${runId}" is not valid JSON: ${reason}`, {
        runId,
        dir,
      });
    }
    return this.validateRecord(parsed, dir);
  }

  private validateRecord(value: unknown, dir: string): RunRecord {
    const result = runRecordSchema.safeParse(value);
    if (!result.success) {
      const problems = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new ArtifactRecordError(`Invalid run record in ${dir}: ${problems}`, { dir });
    }
    return result.data;
  }
}
