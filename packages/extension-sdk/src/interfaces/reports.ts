/**
 * Report generator contract (extensions-spec.md §5).
 *
 * Generators produce markdown reports (daily summary, weekly plan, custom
 * team reports) from local artifacts. Declarative `report_template`
 * contributions describe report *sections*; a `ReportGenerator` computes the
 * content programmatically.
 */

/** Input handed to a report generator by the host. */
export interface ReportInput {
  /** Absolute repository root (reports read `.excalibur/` artifacts). */
  repoRoot: string;
  /** ISO 8601 reference date; defaults to "now" semantics in the generator. */
  date?: string;
  /** Id of a declarative `report_template` to honor, when one is selected. */
  templateId?: string;
  /** Host-provided structured data (runs, patches, commits, …). */
  data?: Record<string, unknown>;
}

/** Result returned by a report generator. */
export interface ReportOutput {
  /** Report title (first heading). */
  title: string;
  /** Full report body as markdown. */
  markdown: string;
  /** Suggested file name under `.excalibur/reports/` (e.g. `daily-2026-06-13.md`). */
  fileName?: string;
}

export interface ReportGenerator {
  /** Stable generator id (e.g. `daily-summary`, `sprint-health`). */
  id: string;
  generate(input: ReportInput): Promise<ReportOutput>;
}
