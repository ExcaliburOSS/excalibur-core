/**
 * PLAN7 — the STRUCTURED re-plan diff. Compares two {@link StructuredPlan} versions
 * (e.g. a plan and its re-planned successor) and reports what CHANGED at the
 * phase/step level: steps added · removed · renamed · moved between phases, and
 * phases added/removed/renamed. Because a re-plan regenerates the positional step
 * ids (`p1.s1`…), matching is by TITLE — exact first, then token-Jaccard fuzzy — so
 * an inserted step doesn't read as "everything after it changed". Pure + total.
 */

import type { StructuredPlan } from './plan-model';

export type PlanStepChange = 'added' | 'removed' | 'unchanged' | 'moved' | 'renamed';

export interface PlanStepDiff {
  change: PlanStepChange;
  /** The current (new-side) title, or the old title for a `removed` step. */
  title: string;
  /** The current (new-side) phase, or the old phase for a `removed` step. */
  phase: string;
  /** The prior title, when `renamed`. */
  oldTitle?: string;
  /** The prior phase, when `moved`. */
  oldPhase?: string;
}

export type PlanPhaseChange = 'added' | 'removed' | 'unchanged' | 'renamed';

export interface PlanPhaseDiff {
  change: PlanPhaseChange;
  title: string;
  oldTitle?: string;
}

export interface PlanDiffSummary {
  added: number;
  removed: number;
  renamed: number;
  moved: number;
  unchanged: number;
}

export interface PlanDiff {
  phases: PlanPhaseDiff[];
  /** Steps in NEW-plan order, with removed steps appended in old order. */
  steps: PlanStepDiff[];
  summary: PlanDiffSummary;
  /** True when nothing changed (every step + phase unchanged). */
  identical: boolean;
}

const FUZZY_THRESHOLD = 0.5;

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
const tokens = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3),
  );

/** Token-set Jaccard similarity of two titles (0–1, deterministic). */
function similarity(a: string, b: string): number {
  if (norm(a) === norm(b)) return 1;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

interface FlatStep {
  title: string;
  phase: string;
  index: number;
}

function flatten(plan: StructuredPlan): FlatStep[] {
  const out: FlatStep[] = [];
  let index = 0;
  for (const phase of plan.phases) {
    for (const step of phase.steps) {
      out.push({ title: step.title, phase: phase.title, index: index++ });
    }
  }
  return out;
}

/** Greedily matches new steps to old steps: exact-title first, then best fuzzy
 * match ≥ threshold. Returns the new→old pairing and the unmatched sets. */
function matchSteps(
  oldSteps: FlatStep[],
  newSteps: FlatStep[],
): { pairs: Map<number, number>; unmatchedOld: Set<number>; unmatchedNew: Set<number> } {
  const pairs = new Map<number, number>(); // newIndex → oldIndex
  const usedOld = new Set<number>();
  const usedNew = new Set<number>();

  // Pass 1 — exact normalized-title matches.
  for (const ns of newSteps) {
    for (const os of oldSteps) {
      if (usedOld.has(os.index)) continue;
      if (norm(os.title) === norm(ns.title)) {
        pairs.set(ns.index, os.index);
        usedOld.add(os.index);
        usedNew.add(ns.index);
        break;
      }
    }
  }

  // Pass 2 — best fuzzy match among the leftovers, highest score wins globally.
  const candidates: { newIndex: number; oldIndex: number; score: number }[] = [];
  for (const ns of newSteps) {
    if (usedNew.has(ns.index)) continue;
    for (const os of oldSteps) {
      if (usedOld.has(os.index)) continue;
      const score = similarity(os.title, ns.title);
      if (score >= FUZZY_THRESHOLD)
        candidates.push({ newIndex: ns.index, oldIndex: os.index, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.newIndex - b.newIndex);
  for (const c of candidates) {
    if (usedNew.has(c.newIndex) || usedOld.has(c.oldIndex)) continue;
    pairs.set(c.newIndex, c.oldIndex);
    usedOld.add(c.oldIndex);
    usedNew.add(c.newIndex);
  }

  const unmatchedOld = new Set(oldSteps.filter((s) => !usedOld.has(s.index)).map((s) => s.index));
  const unmatchedNew = new Set(newSteps.filter((s) => !usedNew.has(s.index)).map((s) => s.index));
  return { pairs, unmatchedOld, unmatchedNew };
}

/** Computes the structured diff from `oldPlan` → `newPlan`. */
export function diffPlans(oldPlan: StructuredPlan, newPlan: StructuredPlan): PlanDiff {
  const oldSteps = flatten(oldPlan);
  const newSteps = flatten(newPlan);
  const byIndexOld = new Map(oldSteps.map((s) => [s.index, s]));
  const { pairs, unmatchedOld, unmatchedNew } = matchSteps(oldSteps, newSteps);

  const steps: PlanStepDiff[] = [];
  // New-plan order: every new step is added / moved / renamed / unchanged.
  for (const ns of newSteps) {
    const oldIndex = pairs.get(ns.index);
    if (oldIndex === undefined) {
      steps.push({ change: 'added', title: ns.title, phase: ns.phase });
      continue;
    }
    const os = byIndexOld.get(oldIndex)!;
    const titleChanged = norm(os.title) !== norm(ns.title);
    const phaseChanged = norm(os.phase) !== norm(ns.phase);
    if (titleChanged) {
      steps.push({
        change: 'renamed',
        title: ns.title,
        phase: ns.phase,
        oldTitle: os.title,
        ...(phaseChanged ? { oldPhase: os.phase } : {}),
      });
    } else if (phaseChanged) {
      steps.push({ change: 'moved', title: ns.title, phase: ns.phase, oldPhase: os.phase });
    } else {
      steps.push({ change: 'unchanged', title: ns.title, phase: ns.phase });
    }
  }
  // Removed steps (in old order) appended.
  for (const os of oldSteps) {
    if (unmatchedOld.has(os.index)) {
      steps.push({ change: 'removed', title: os.title, phase: os.phase });
    }
  }
  void unmatchedNew; // (already emitted as 'added' above)

  // Phase-level diff by title (exact then fuzzy).
  const phases = diffPhases(oldPlan, newPlan);

  const summary: PlanDiffSummary = {
    added: steps.filter((s) => s.change === 'added').length,
    removed: steps.filter((s) => s.change === 'removed').length,
    renamed: steps.filter((s) => s.change === 'renamed').length,
    moved: steps.filter((s) => s.change === 'moved').length,
    unchanged: steps.filter((s) => s.change === 'unchanged').length,
  };
  const identical =
    summary.added === 0 &&
    summary.removed === 0 &&
    summary.renamed === 0 &&
    summary.moved === 0 &&
    phases.every((p) => p.change === 'unchanged');

  return { phases, steps, summary, identical };
}

function diffPhases(oldPlan: StructuredPlan, newPlan: StructuredPlan): PlanPhaseDiff[] {
  const oldTitles = oldPlan.phases.map((p) => p.title);
  const newTitles = newPlan.phases.map((p) => p.title);
  const usedOld = new Set<number>();
  const out: PlanPhaseDiff[] = [];

  for (const title of newTitles) {
    // Exact, then fuzzy, against unused old phases.
    let matched = oldTitles.findIndex((t, i) => !usedOld.has(i) && norm(t) === norm(title));
    let renamed = false;
    if (matched < 0) {
      let best = -1;
      let bestScore = FUZZY_THRESHOLD;
      oldTitles.forEach((t, i) => {
        if (usedOld.has(i)) return;
        const s = similarity(t, title);
        if (s >= bestScore) {
          bestScore = s;
          best = i;
        }
      });
      if (best >= 0) {
        matched = best;
        renamed = true;
      }
    }
    if (matched >= 0) {
      usedOld.add(matched);
      out.push(
        renamed
          ? { change: 'renamed', title, oldTitle: oldTitles[matched] }
          : { change: 'unchanged', title },
      );
    } else {
      out.push({ change: 'added', title });
    }
  }
  oldTitles.forEach((t, i) => {
    if (!usedOld.has(i)) out.push({ change: 'removed', title: t });
  });
  return out;
}

const STEP_MARK: Record<PlanStepChange, string> = {
  added: '+',
  removed: '−',
  renamed: '~',
  moved: '→',
  unchanged: '=',
};

/**
 * Renders the diff as plain lines (a one-line summary + a per-step `+/−/~/→/=` list,
 * grouped by the new-plan phase). Colour is the caller's concern.
 */
export function renderPlanDiff(diff: PlanDiff): string[] {
  if (diff.identical) {
    return ['No changes — the plan is identical.'];
  }
  const s = diff.summary;
  const bits: string[] = [];
  if (s.added > 0) bits.push(`+${s.added} added`);
  if (s.removed > 0) bits.push(`−${s.removed} removed`);
  if (s.renamed > 0) bits.push(`~${s.renamed} renamed`);
  if (s.moved > 0) bits.push(`→${s.moved} moved`);
  const lines: string[] = [`Plan changed: ${bits.join(', ')} (${s.unchanged} unchanged).`];

  let lastPhase: string | null = null;
  for (const step of diff.steps) {
    if (step.phase !== lastPhase) {
      lines.push(`  ${step.phase}`);
      lastPhase = step.phase;
    }
    const mark = STEP_MARK[step.change];
    if (step.change === 'renamed') {
      lines.push(`   ${mark} ${step.oldTitle} → ${step.title}`);
    } else if (step.change === 'moved') {
      lines.push(`   ${mark} ${step.title}  (from "${step.oldPhase}")`);
    } else {
      lines.push(`   ${mark} ${step.title}`);
    }
  }
  return lines;
}
