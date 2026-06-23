import { planVerificationMesh, runVerificationMesh, type MeshResult } from '@excalibur/core';
import type { ModelGateway } from '@excalibur/model-gateway';
import type { ExcaliburConfig } from '@excalibur/shared';

/** What the proportional mesh needs (already resolved by the caller). */
export interface MeshContext {
  gateway: ModelGateway;
  providerName: string;
  config: ExcaliburConfig;
}

/**
 * Runs a PROPORTIONAL adversarial Verification-Mesh over a diff (AO4f), shared by
 * the swarm verified fan-in (AO4f-1) and the sequential auto-build (AO4f-2).
 * `planVerificationMesh` sizes the jury to the change (docs → none). Returns the
 * result + lens count, or null when nothing is warranted or on ANY error —
 * best-effort, a flaky jury never blocks the caller. The caller prints + decides.
 */
export async function runProportionalMesh(
  ctx: MeshContext,
  diff: string,
): Promise<{ result: MeshResult; lenses: number } | null> {
  try {
    const fileCount = (diff.match(/^diff --git /gm) ?? []).length || 1;
    const plan = planVerificationMesh({
      taskType: 'feature',
      sensitive: false,
      affectedUnits: fileCount,
      autonomyLevel: ctx.config.autonomy?.default ?? 3,
      hasTests: typeof ctx.config.commands?.test === 'string',
      ...(ctx.config.verification?.mesh !== undefined
        ? { mode: ctx.config.verification.mesh }
        : {}),
    });
    if (plan.lenses.length === 0) {
      return null;
    }
    const result = await runVerificationMesh({
      diff,
      lenses: plan.lenses,
      gateway: ctx.gateway,
      provider: ctx.providerName,
    });
    return { result, lenses: plan.lenses.length };
  } catch {
    return null;
  }
}
