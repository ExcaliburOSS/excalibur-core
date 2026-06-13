/**
 * Enterprise sync contract types (Build Contract §4.8, OSS spec §13).
 *
 * @experimental Enterprise sync is experimental in M1. The wire format and the
 * client surface may change before the Enterprise control plane ships; nothing
 * here is required for local-only usage — without `excalibur login` everything
 * stays on disk.
 */
import { z } from 'zod';
import type { ExcaliburEvent, LocalRun } from '@excalibur/shared';

/**
 * Repository-scoped configuration provided by Excalibur Enterprise.
 *
 * Enterprise can centrally pin allowed models, team workflow/policy defaults
 * and sensitive path rules; Core merges them over the local `.excalibur/`
 * configuration. All sections are optional — an empty object is a valid
 * (no-overrides) Enterprise config.
 *
 * @experimental Experimental in M1; richer shapes arrive with the Enterprise
 * control plane.
 */
export interface EnterpriseConfig {
  /** Model identifiers the organization allows for this repository. */
  allowedModels?: string[];
  /** Enterprise-provided workflow definitions (validated downstream). */
  workflows?: unknown[];
  /** Enterprise-provided policy presets (validated downstream). */
  policies?: unknown[];
  /** Team-level defaults merged over local config defaults. */
  teamDefaults?: Record<string, unknown>;
  /** Glob patterns the organization marks as sensitive. */
  sensitivePaths?: string[];
}

/**
 * Zod companion for {@link EnterpriseConfig}. Unknown keys are preserved
 * (`passthrough`) so newer Enterprise servers can ship additional sections
 * without breaking older CLI versions.
 *
 * @experimental
 */
export const enterpriseConfigSchema: z.ZodType<EnterpriseConfig> = z
  .object({
    allowedModels: z.array(z.string()).optional(),
    workflows: z.array(z.unknown()).optional(),
    policies: z.array(z.unknown()).optional(),
    teamDefaults: z.record(z.unknown()).optional(),
    sensitivePaths: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * Client contract between Excalibur Core and Excalibur Enterprise
 * (OSS spec §13, verbatim-normative).
 *
 * Sync is optional and transparent: callers must treat every method as
 * best-effort and never block local workflows on it.
 *
 * @experimental Experimental in M1 — the HTTP implementation talks to a
 * not-yet-public control plane.
 */
export interface EnterpriseSyncClient {
  /** Pushes a local run (its `run.json` record and id) to Enterprise. */
  pushRun(run: LocalRun): Promise<void>;
  /** Pushes a single canonical event line to Enterprise ingestion. */
  pushEvent(event: ExcaliburEvent): Promise<void>;
  /** Pulls the organization/repository configuration from Enterprise. */
  pullConfig(repositoryId?: string): Promise<EnterpriseConfig>;
}
