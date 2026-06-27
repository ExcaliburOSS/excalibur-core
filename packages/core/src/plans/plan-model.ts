/**
 * The STRUCTURED plan model — the machine-addressable source of truth for a plan,
 * persisted next to the human `.md` as `<id>.plan.json` (see plan-store.ts).
 *
 * Why: a plan stored only as prose markdown can't carry first-class sub-phases,
 * per-step status, dependencies or acceptance criteria — so resume-at-exact-step,
 * a live plan tree and plan→work-item linkage are impossible from the text alone.
 * This model makes those first-class while a generated markdown view stays the
 * human-readable artifact. {@link parsePlanMarkdown} derives a best-effort structure
 * from an OLD prose plan (back-compat); {@link renderPlanMarkdown} regenerates the
 * `.md` from the structure for new plans. Round-trips on the status checkboxes.
 */

/** The lifecycle of a single step within a plan. */
export type PlanStepStatus = 'pending' | 'active' | 'done' | 'blocked' | 'skipped';

export interface PlanStep {
  /** Stable id within the plan, e.g. `p1.s2`. */
  id: string;
  title: string;
  status: PlanStepStatus;
  /** Ids of steps this one depends on (must be done first). */
  deps?: string[];
  /** Acceptance criteria / definition of done. */
  acceptance?: string;
  /** The run that executed this step, once it ran. */
  runId?: string;
  /** A linked work-item (PLAN2). */
  workItemId?: string;
}

export interface PlanPhase {
  /** Stable id within the plan, e.g. `p1`. */
  id: string;
  title: string;
  steps: PlanStep[];
}

export interface StructuredPlan {
  /** Schema version — bump on a breaking shape change. */
  version: 1;
  phases: PlanPhase[];
  /** The EPIC work-item the plan was materialized into (PLAN2), once it was. */
  epicWorkItemId?: string;
}

const ALL_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'active',
  'done',
  'blocked',
  'skipped',
]);

/** A `[x]`-style checkbox marker ⇄ a status (used by render + parse, so they round-trip). */
const MARKER_TO_STATUS: Record<string, PlanStepStatus> = {
  ' ': 'pending',
  x: 'done',
  X: 'done',
  '~': 'active',
  '!': 'blocked',
  '-': 'skipped',
};
const STATUS_TO_MARKER: Record<PlanStepStatus, string> = {
  pending: ' ',
  active: '~',
  done: 'x',
  blocked: '!',
  skipped: '-',
};

/** True when `value` is a valid {@link StructuredPlan} (defensive — sidecar JSON is on disk). */
export function isStructuredPlan(value: unknown): value is StructuredPlan {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const plan = value as { version?: unknown; phases?: unknown };
  if (plan.version !== 1 || !Array.isArray(plan.phases)) {
    return false;
  }
  return plan.phases.every((phase) => {
    if (typeof phase !== 'object' || phase === null) {
      return false;
    }
    const p = phase as { id?: unknown; title?: unknown; steps?: unknown };
    return typeof p.id === 'string' && typeof p.title === 'string' && Array.isArray(p.steps);
  });
}

/** `{ total, done, active, blocked }` — for a progress meter and resume. */
export function planProgress(plan: StructuredPlan): {
  total: number;
  done: number;
  active: number;
  blocked: number;
} {
  let total = 0;
  let done = 0;
  let active = 0;
  let blocked = 0;
  for (const phase of plan.phases) {
    for (const step of phase.steps) {
      total += 1;
      if (step.status === 'done') done += 1;
      else if (step.status === 'active') active += 1;
      else if (step.status === 'blocked') blocked += 1;
    }
  }
  return { total, done, active, blocked };
}

/** The first step that is neither done nor skipped — where a resume continues. */
export function nextPendingStep(plan: StructuredPlan): { phase: PlanPhase; step: PlanStep } | null {
  for (const phase of plan.phases) {
    for (const step of phase.steps) {
      if (step.status !== 'done' && step.status !== 'skipped') {
        return { phase, step };
      }
    }
  }
  return null;
}

/** Finds a step (and its phase) by id, or null. */
export function findStep(
  plan: StructuredPlan,
  stepId: string,
): { phase: PlanPhase; step: PlanStep } | null {
  for (const phase of plan.phases) {
    for (const step of phase.steps) {
      if (step.id === stepId) {
        return { phase, step };
      }
    }
  }
  return null;
}

const HEADING_RE = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const BOLD_HEADING_RE = /^\s{0,3}\*\*(.+?)\*\*:?\s*$/;
// A list item: `1.` / `1)` / `-` / `*` / `+`, an optional `[ ]` status box, then the text.
const STEP_RE = /^(\s*)(?:\d+[.)]|[-*+])\s+(?:\[([ xX~!-])\]\s+)?(.+?)\s*$/;

/** Strips a leading "Phase 2:" / "Step 1 -" style label so the title reads cleanly. */
function cleanPhaseTitle(raw: string): string {
  return raw.replace(/^\s*(?:phase|fase|stage|etapa)\s*\d+\s*[:.\-–]\s*/i, '').trim() || raw.trim();
}

/**
 * Best-effort parse of a prose markdown plan into a {@link StructuredPlan}: headings
 * (or bold-only lines) become PHASES; list items become STEPS of the current phase
 * (a default "Plan" phase holds steps that precede any heading). A `[x]`-style box on
 * a step carries its status. Never throws; an empty/odd plan yields `{version:1,phases:[]}`
 * (or a single empty "Plan" phase when there is text but no list items).
 */
export function parsePlanMarkdown(markdown: string): StructuredPlan {
  const phases: PlanPhase[] = [];
  let current: PlanPhase | null = null;
  let sawAnyText = false;

  const ensurePhase = (): PlanPhase => {
    if (current === null) {
      current = { id: `p${phases.length + 1}`, title: 'Plan', steps: [] };
      phases.push(current);
    }
    return current;
  };

  for (const rawLine of (markdown ?? '').split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim().length === 0) {
      continue;
    }
    sawAnyText = true;

    const step = STEP_RE.exec(line);
    if (step !== null) {
      const phase = ensurePhase();
      const marker = step[2];
      const status: PlanStepStatus =
        marker !== undefined && marker in MARKER_TO_STATUS
          ? (MARKER_TO_STATUS[marker] as PlanStepStatus)
          : 'pending';
      phase.steps.push({
        id: `${phase.id}.s${phase.steps.length + 1}`,
        title: (step[3] ?? '').trim(),
        status,
      });
      continue;
    }

    const heading = HEADING_RE.exec(line) ?? BOLD_HEADING_RE.exec(line);
    if (heading !== null) {
      current = {
        id: `p${phases.length + 1}`,
        title: cleanPhaseTitle(heading[1] ?? ''),
        steps: [],
      };
      phases.push(current);
      continue;
    }
    // Any other prose line is ignored for the structure (it stays in the .md body).
  }

  // Drop phases that ended up with no steps, UNLESS that leaves nothing while there
  // was text — then keep a single empty "Plan" phase so the plan isn't structureless.
  const withSteps = phases.filter((p) => p.steps.length > 0);
  if (withSteps.length > 0) {
    return { version: 1, phases: reindex(withSteps) };
  }
  if (sawAnyText) {
    return { version: 1, phases: [{ id: 'p1', title: 'Plan', steps: [] }] };
  }
  return { version: 1, phases: [] };
}

/** Re-issues stable ids after filtering empty phases, keeping step ids phase-scoped. */
function reindex(phases: PlanPhase[]): PlanPhase[] {
  return phases.map((phase, pi) => {
    const id = `p${pi + 1}`;
    return {
      ...phase,
      id,
      steps: phase.steps.map((step, si) => ({ ...step, id: `${id}.s${si + 1}` })),
    };
  });
}

/**
 * Renders a {@link StructuredPlan} to the human markdown view: a `##` heading per
 * phase, a checkbox list item per step (`- [x] …`) carrying its status, with the
 * acceptance criteria as a dim sub-bullet. {@link parsePlanMarkdown} reads it back.
 */
export function renderPlanMarkdown(plan: StructuredPlan): string {
  if (plan.phases.length === 0) {
    return '_No steps yet._';
  }
  const out: string[] = [];
  const single = plan.phases.length === 1 && plan.phases[0]?.title === 'Plan';
  for (const phase of plan.phases) {
    if (!single) {
      out.push(`## ${phase.title}`, '');
    }
    for (const step of phase.steps) {
      const status = ALL_STATUSES.has(step.status) ? step.status : 'pending';
      out.push(`- [${STATUS_TO_MARKER[status]}] ${step.title}`);
      if (step.acceptance !== undefined && step.acceptance.length > 0) {
        out.push(`  - _acceptance:_ ${step.acceptance}`);
      }
    }
    out.push('');
  }
  return out.join('\n').replace(/\n+$/, '\n').trimEnd();
}
