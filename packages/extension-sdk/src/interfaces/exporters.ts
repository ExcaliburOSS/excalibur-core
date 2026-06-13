/**
 * Exporter contract (extensions-spec.md §5).
 *
 * Exporters push local Excalibur artifacts (runs, patches, discovery
 * sessions, reports) to external destinations — a data warehouse, an S3
 * bucket, a metrics pipeline. M1 ships no real exporter; the interface is the
 * stable surface extensions code against.
 */

/** Input handed to an exporter by the host. */
export interface ExportInput {
  /** Absolute repository root (exporters read `.excalibur/` artifacts). */
  repoRoot: string;
  /** Kind of artifacts to export (e.g. `runs`, `patches`, `reports`). */
  kind?: string;
  /** Specific artifact ids to export; all of `kind` when omitted. */
  ids?: string[];
  /** Destination hint (URL, bucket, path) when not fixed by extension config. */
  destination?: string;
  /** Exporter-specific options. */
  options?: Record<string, unknown>;
}

/** Result returned by an exporter. */
export interface ExportResult {
  /** `true` when the export completed (possibly with warnings). */
  success: boolean;
  /** Number of artifacts exported. */
  exportedCount: number;
  /** Where the artifacts ended up, when meaningful. */
  destination?: string;
  /** Non-fatal issues encountered while exporting. */
  warnings?: string[];
}

export interface Exporter {
  /** Stable exporter id (e.g. `s3-archive`, `warehouse`). */
  id: string;
  export(input: ExportInput): Promise<ExportResult>;
}
