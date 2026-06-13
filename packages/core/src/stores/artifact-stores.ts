import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { autonomyLevelSchema, type AutonomyLevel, type ExcaliburError } from '@excalibur/shared';
import { EXCALIBUR_DIR } from '../config/load-config';
import {
  ArtifactRecordError,
  InteractionNotFoundError,
  PatchNotFoundError,
} from '../errors';
import {
  listSubdirectories,
  readTextIfExists,
  reserveTimestampDir,
  writeFileEnsured,
} from '../internal/fs-utils';

/**
 * Local artifact stores for the non-run commands (ONB-8, onboarding spec §7):
 *
 * - `.excalibur/patches/<patch_YYYYMMDD_HHMMSS>/` — input.md,
 *   effective-instructions.md, diff.patch, summary.md, metadata.json
 * - `.excalibur/interactions/<int_YYYYMMDD_HHMMSS>/` — input.md,
 *   effective-instructions.md, output.md, metadata.json
 *
 * `metadata.json` records command, workflow, autonomy level, model/provider,
 * instruction sources used, warnings, cost and timestamps.
 */

export const patchStatusSchema = z.enum(['proposed', 'applied', 'branch_created', 'rejected', 'cancelled']);
export type PatchStatus = z.infer<typeof patchStatusSchema>;

export const interactionStatusSchema = z.enum(['completed', 'cancelled']);
export type InteractionStatus = z.infer<typeof interactionStatusSchema>;

const baseMetadataShape = {
  id: z.string().min(1),
  command: z.string().min(1),
  workflow: z.string().nullable(),
  autonomyLevel: autonomyLevelSchema,
  model: z.string().nullable(),
  provider: z.string().nullable(),
  instructionSources: z.array(z.string()),
  warnings: z.array(z.string()),
  costCents: z.number().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).nullable(),
};

export const patchMetadataSchema = z.object({
  ...baseMetadataShape,
  status: patchStatusSchema,
  /**
   * Result of validating `diff.patch` with `git apply --check` at proposal
   * time: `true` (applies), `false` (does not), or `null` (not validated —
   * e.g. an empty diff or a pre-Slice-3 artifact). Additive/optional so older
   * artifacts and hand-written fixtures parse unchanged.
   */
  diffApplies: z.boolean().nullable().optional(),
});
export type PatchMetadata = z.infer<typeof patchMetadataSchema>;

export const interactionMetadataSchema = z.object({
  ...baseMetadataShape,
  status: interactionStatusSchema,
});
export type InteractionMetadata = z.infer<typeof interactionMetadataSchema>;

/** A stored artifact set: its id, directory and parsed metadata.json. */
export interface StoredArtifact<TMetadata> {
  id: string;
  dir: string;
  metadata: TMetadata;
}

export type LocalPatch = StoredArtifact<PatchMetadata>;
export type LocalInteraction = StoredArtifact<InteractionMetadata>;

interface CommonCreateInput {
  command?: string;
  workflow?: string | null;
  autonomyLevel?: AutonomyLevel;
  model?: string | null;
  provider?: string | null;
  /** Content of `input.md` (the task / question). */
  input: string;
  /** Content of `effective-instructions.md`. */
  effectiveInstructions: string;
  /** Instruction source paths used to build the effective context. */
  instructionSources?: string[];
  warnings?: string[];
  costCents?: number | null;
}

export interface CreatePatchInput extends CommonCreateInput {
  /** Content of `diff.patch`. */
  diff: string;
  /** Content of `summary.md`. */
  summary: string;
  /** `git apply --check` result for `diff` at proposal time (null = not validated). */
  diffApplies?: boolean | null;
}

export interface CreateInteractionInput extends CommonCreateInput {
  /** Content of `output.md` (the rendered answer). */
  output: string;
}

const METADATA_FILE = 'metadata.json';

abstract class LocalArtifactStore<TMetadata extends { id: string }> {
  protected readonly baseDir: string;
  protected abstract readonly idPrefix: string;
  protected abstract readonly metadataSchema: z.ZodType<TMetadata>;

  constructor(repoRoot: string, subdir: string) {
    this.baseDir = join(repoRoot, EXCALIBUR_DIR, subdir);
  }

  protected abstract notFound(id: string): ExcaliburError;

  get(id: string): StoredArtifact<TMetadata> {
    const dir = join(this.baseDir, id);
    if (!existsSync(join(dir, METADATA_FILE))) {
      throw this.notFound(id);
    }
    return { id, dir, metadata: this.readMetadata(dir) };
  }

  list(): Array<StoredArtifact<TMetadata>> {
    const artifacts: Array<StoredArtifact<TMetadata>> = [];
    for (const name of listSubdirectories(this.baseDir)) {
      const dir = join(this.baseDir, name);
      try {
        artifacts.push({ id: name, dir, metadata: this.readMetadata(dir) });
      } catch {
        // Tolerant listing: a corrupted artifact dir never breaks `status`.
      }
    }
    return artifacts;
  }

  /** Merges a metadata patch (e.g. status changes) and persists it. */
  update(id: string, patch: Partial<TMetadata>): StoredArtifact<TMetadata> {
    const existing = this.get(id);
    const merged = this.validate({ ...existing.metadata, ...patch, id }, existing.dir);
    this.writeMetadata(existing.dir, merged);
    return { id, dir: existing.dir, metadata: merged };
  }

  /** Reads one of the artifact's files (`null` when it does not exist). */
  readArtifact(id: string, fileName: string): string | null {
    const { dir } = this.get(id);
    return readTextIfExists(join(dir, fileName));
  }

  /** Atomically reserves a fresh artifact directory (race-safe across processes). */
  protected reserveDir(): { id: string; dir: string } {
    return reserveTimestampDir(this.baseDir, this.idPrefix);
  }

  protected writeMetadata(dir: string, metadata: TMetadata): void {
    writeFileEnsured(join(dir, METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`);
  }

  private readMetadata(dir: string): TMetadata {
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
    return this.validate(parsed, dir);
  }

  private validate(value: unknown, dir: string): TMetadata {
    const result = this.metadataSchema.safeParse(value);
    if (!result.success) {
      const problems = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new ArtifactRecordError(`Invalid ${METADATA_FILE} in ${dir}: ${problems}`, { dir });
    }
    return result.data;
  }
}

/** Local patch artifact store (`.excalibur/patches/`). */
export class PatchStore extends LocalArtifactStore<PatchMetadata> {
  protected readonly idPrefix = 'patch';
  protected readonly metadataSchema = patchMetadataSchema;

  constructor(repoRoot: string) {
    super(repoRoot, 'patches');
  }

  protected notFound(id: string): ExcaliburError {
    return new PatchNotFoundError(`Patch "${id}" was not found under ${this.baseDir}.`, { id });
  }

  create(input: CreatePatchInput): LocalPatch {
    const { id, dir } = this.reserveDir();

    const metadata: PatchMetadata = {
      id,
      command: input.command ?? 'patch',
      workflow: input.workflow ?? 'propose-patch',
      autonomyLevel: input.autonomyLevel ?? 2,
      model: input.model ?? null,
      provider: input.provider ?? null,
      instructionSources: input.instructionSources ?? [],
      warnings: input.warnings ?? [],
      costCents: input.costCents ?? null,
      status: 'proposed',
      diffApplies: input.diffApplies ?? null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };

    writeFileEnsured(join(dir, 'input.md'), input.input);
    writeFileEnsured(join(dir, 'effective-instructions.md'), input.effectiveInstructions);
    writeFileEnsured(join(dir, 'diff.patch'), input.diff);
    writeFileEnsured(join(dir, 'summary.md'), input.summary);
    this.writeMetadata(dir, metadata);

    return { id, dir, metadata };
  }
}

/** Local interaction artifact store (`.excalibur/interactions/`). */
export class InteractionStore extends LocalArtifactStore<InteractionMetadata> {
  protected readonly idPrefix = 'int';
  protected readonly metadataSchema = interactionMetadataSchema;

  constructor(repoRoot: string) {
    super(repoRoot, 'interactions');
  }

  protected notFound(id: string): ExcaliburError {
    return new InteractionNotFoundError(
      `Interaction "${id}" was not found under ${this.baseDir}.`,
      { id },
    );
  }

  create(input: CreateInteractionInput): LocalInteraction {
    const { id, dir } = this.reserveDir();

    const metadata: InteractionMetadata = {
      id,
      command: input.command ?? 'ask',
      workflow: input.workflow ?? 'ask-repo',
      autonomyLevel: input.autonomyLevel ?? 1,
      model: input.model ?? null,
      provider: input.provider ?? null,
      instructionSources: input.instructionSources ?? [],
      warnings: input.warnings ?? [],
      costCents: input.costCents ?? null,
      status: 'completed',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    writeFileEnsured(join(dir, 'input.md'), input.input);
    writeFileEnsured(join(dir, 'effective-instructions.md'), input.effectiveInstructions);
    writeFileEnsured(join(dir, 'output.md'), input.output);
    this.writeMetadata(dir, metadata);

    return { id, dir, metadata };
  }
}
