import type { TaskType } from '../onboarding/onboarding';

/**
 * The VERIFICATION MESH (plan differentiator) — the deterministic "brain" that
 * decides, PROPORTIONALLY, how many adversarial verifier lenses to run over a
 * change and aggregates their verdicts into a pass/blocked result. The mesh
 * itself (running N isolated verifiers via the swarm engine) is the orchestrator
 * that consumes this; this module is pure + testable, like `planAgentAllocation`
 * is for the swarm.
 *
 * Proportional: a typo gets nothing, a sensitive/high-autonomy change gets the
 * full jury. Governable: `mode` ('off' | 'auto' | 'always') comes from config /
 * Enterprise policy. Never a knob the user must set.
 */

export type MeshLens = 'correctness' | 'security' | 'regression' | 'spec' | 'reproduce';
export type MeshMode = 'off' | 'auto' | 'always';

/** Human-facing label + the adversarial focus each lens applies. */
export const MESH_LENSES: Record<MeshLens, { label: string; focus: string }> = {
  correctness: {
    label: 'Correctness',
    focus: 'logic errors, off-by-one, edge cases, and whether it does what was asked',
  },
  security: {
    label: 'Security',
    focus: 'injection, secret handling, auth, unsafe shell/network, data exposure',
  },
  regression: {
    label: 'Regression',
    focus: 'behaviour that used to work but the change may have broken; side effects',
  },
  spec: {
    label: 'Spec',
    focus: 'the stated requirements/acceptance criteria, and scope-creep beyond them',
  },
  reproduce: {
    label: 'Reproduce',
    focus: 'actually running the tests/repro — evidence, not opinion',
  },
};

export interface MeshPlanInput {
  taskType: TaskType;
  sensitive: boolean;
  /** Distinct modules/files the change touches (blast radius). */
  affectedUnits?: number;
  /** 0–4. Higher autonomy → verify HARDER (it ran with less human oversight). */
  autonomyLevel: number;
  /** Whether a test/verify command exists (enables the `reproduce` lens). */
  hasTests?: boolean;
  /** Governance: off disables the mesh; always forces ≥1 lens even on trivia. */
  mode?: MeshMode;
}

export interface MeshPlan {
  lenses: MeshLens[];
  /** Explainable reason for the chosen breadth (shown to the user). */
  reason: string;
}

/**
 * Decides which verifier lenses run, scaled to risk. Order matters only for
 * display; duplicates are removed.
 */
export function planVerificationMesh(input: MeshPlanInput): MeshPlan {
  const mode = input.mode ?? 'auto';
  if (mode === 'off') {
    return { lenses: [], reason: 'verification mesh disabled (mode: off)' };
  }
  const units = input.affectedUnits ?? 1;
  const highAutonomy = input.autonomyLevel >= 3;

  // Trivial: docs / a small unsensitive bugfix at low autonomy needs no jury
  // (unless policy forces it).
  const trivial =
    input.taskType === 'docs' ||
    (input.taskType === 'bugfix' && !input.sensitive && units <= 1 && !highAutonomy);
  if (trivial && mode !== 'always') {
    return input.taskType === 'docs'
      ? { lenses: [], reason: 'a docs change does not warrant adversarial verification' }
      : { lenses: ['correctness'], reason: 'a small low-risk change: one correctness lens' };
  }

  const lenses = new Set<MeshLens>(['correctness']);
  if (input.sensitive || input.taskType === 'security') {
    lenses.add('security');
  }
  if (units > 1 || input.taskType === 'refactor' || input.taskType === 'migration') {
    lenses.add('regression');
  }
  if (input.taskType === 'feature' || input.taskType === 'alternatives') {
    lenses.add('spec');
  }
  if (input.hasTests === true) {
    lenses.add('reproduce');
  }

  const list = [...lenses];
  const why: string[] = [];
  if (input.sensitive) why.push('sensitive paths');
  if (highAutonomy) why.push(`autonomy L${input.autonomyLevel}`);
  if (units > 1) why.push(`${units} modules`);
  const reason =
    mode === 'always' && list.length === 1
      ? 'verification mesh forced on (mode: always)'
      : `${list.length}-lens mesh${why.length > 0 ? ` because ${why.join(', ')}` : ''}`;
  return { lenses: list, reason };
}

export interface MeshIssue {
  lens: MeshLens;
  severity: 'high' | 'medium' | 'low';
  file?: string;
  problem: string;
  fix?: string;
}

export interface MeshVerdict {
  lens: MeshLens;
  issues: MeshIssue[];
  /** True when the lens hunted and found nothing. */
  clean: boolean;
}

export interface MeshResult {
  /** A blocking (high-severity) issue survived → the run must NOT reach completed. */
  blocked: boolean;
  /** All surviving issues, sorted high→low. */
  issues: MeshIssue[];
  lensesRun: MeshLens[];
  summary: string;
}

const SEVERITY_RANK: Record<MeshIssue['severity'], number> = { high: 0, medium: 1, low: 2 };

/**
 * Aggregates the jurors' verdicts: a HIGH issue from ANY lens blocks the run
 * (a single juror catching a real high-severity problem is enough — the mesh's
 * job is to maximise the chance SOMEONE catches it). Issues sorted high→low.
 */
export function aggregateMesh(verdicts: ReadonlyArray<MeshVerdict>): MeshResult {
  const issues = verdicts
    .flatMap((v) => v.issues)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const blocked = issues.some((i) => i.severity === 'high');
  const lensesRun = verdicts.map((v) => v.lens);
  const counts = { high: 0, medium: 0, low: 0 };
  for (const i of issues) counts[i.severity] += 1;
  const summary =
    issues.length === 0
      ? `Verification mesh (${lensesRun.length} lens) — clean.`
      : `Verification mesh (${lensesRun.length} lens) — ${counts.high} high, ${counts.medium} medium, ${counts.low} low${blocked ? ' (BLOCKING)' : ''}.`;
  return { blocked, issues, lensesRun, summary };
}
