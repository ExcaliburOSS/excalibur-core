/**
 * AO9-1 — the "Understand-first" SCOPE engine.
 *
 * A read-only, auto-dimensioned exploration fan-out that maps a coding task
 * BEFORE planning or building: it decomposes the task into N exploration ANGLES
 * (auto-sized to complexity — a read-only analog of `chooseConcurrency`), fans out
 * one READ-ONLY explorer per angle, and synthesizes their fragments into a single
 * {@link ScopeMap} (relevant files/subsystems, what EXISTS vs what's MISSING,
 * risks/unknowns). The map feeds plan-shaping and the planner.
 *
 * This module is the PURE engine: the model (`classify`) and the per-angle explorer
 * (`explore`) are INJECTED, so core stays SDK-free and the orchestration is
 * unit-testable with fakes. The CLI backs `explore` with a real read-only agent
 * (read/list/search tools ONLY — never write/patch/run); that allowlist is the
 * safety floor. Distinct from the meta-orchestrator (which EXECUTES a capability
 * DAG): scope is read-only understanding that comes BEFORE building.
 */

import type { IntentModel } from '../sessions/intent-router';
import { firstJsonObject } from '../sessions/plan-shaping';
import { buildSchemaInstruction, type JsonSchema } from '../structured/structured-output';

/** How big the task looks — drives the number of exploration angles. */
export type ScopeComplexity = 'small' | 'medium' | 'large';

/** One exploration ANGLE: a subsystem / question to investigate read-only. */
export interface ScopeAngle {
  id: string;
  /** The subsystem or area to look at (e.g. "auth", "the run store"). */
  subsystem: string;
  /** What this explorer should find out. */
  question: string;
}

/** What one explorer found about its angle (the schema-forced explorer output). */
export interface ScopeFragment {
  subsystem: string;
  /** Relevant files (paths, optionally `path:line`). */
  files: string[];
  /** What is ALREADY built for this area. */
  whatExists: string;
  /** What the task still NEEDS here (the gap). */
  whatsMissing: string;
  /** Risks, unknowns, gotchas. */
  risks: string[];
}

/** The merged understanding of a task — the deliverable that feeds planning. */
export interface ScopeMap {
  task: string;
  /** A one-to-two sentence synthesis of the territory. */
  summary: string;
  /** Per-subsystem findings (one per explored angle, deduped/merged). */
  subsystems: ScopeFragment[];
  /** Top cross-cutting risks. */
  risks: string[];
  /** What is still unclear and would change the plan. */
  openQuestions: string[];
}

/** The JSON Schema an explorer's fragment must satisfy (reuse for schema-forced
 * output via AO7-4's `outputSchema`). */
export const SCOPE_FRAGMENT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['subsystem', 'files', 'whatExists', 'whatsMissing', 'risks'],
  properties: {
    subsystem: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    whatExists: { type: 'string' },
    whatsMissing: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
  },
};

const ANGLE_HARD_CAP = 8;

/**
 * Auto-dimensions the number of exploration angles — the read-only analog of
 * `chooseConcurrency`: a small task needs a couple of look-ups, a large one a
 * wider sweep. Bounded (never a fan-out bomb).
 */
export function scopeAngleCount(input: { complexity: ScopeComplexity; hardCap?: number }): number {
  const base = input.complexity === 'small' ? 2 : input.complexity === 'large' ? 6 : 4;
  return Math.max(1, Math.min(base, input.hardCap ?? ANGLE_HARD_CAP));
}

/** Builds the decomposition prompt: the model proposes up to `maxAngles` read-only
 * exploration angles for the task, in ANY language (no keyword logic). */
export function buildScopeAnglesPrompt(task: string, maxAngles: number): string {
  return [
    'You are scoping a coding task in an existing codebase BEFORE any code is written.',
    `Propose up to ${maxAngles} READ-ONLY exploration angles — the distinct subsystems / areas`,
    'someone must read to understand what already exists and what the task still needs. Each angle',
    'is one focused question. Cover the breadth of the task; do NOT propose writing anything.',
    'Respond with ONLY JSON: {"angles":[{"subsystem":"...","question":"..."}]} — no prose, no fence.',
    '',
    `Task: ${task}`,
  ].join('\n');
}

/** Parses the model's angle list into {@link ScopeAngle}s (ids assigned); [] if none. */
export function parseScopeAngles(modelOutput: string): ScopeAngle[] {
  const obj = firstJsonObject(modelOutput);
  const raw = obj !== null && Array.isArray(obj['angles']) ? (obj['angles'] as unknown[]) : [];
  const angles: ScopeAngle[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const a = item as Record<string, unknown>;
    const subsystem = typeof a['subsystem'] === 'string' ? a['subsystem'].trim() : '';
    const question = typeof a['question'] === 'string' ? a['question'].trim() : '';
    if (subsystem.length === 0 && question.length === 0) continue;
    angles.push({
      id: `angle_${angles.length + 1}`,
      subsystem: subsystem.length > 0 ? subsystem : question,
      question: question.length > 0 ? question : subsystem,
    });
  }
  return angles;
}

/** Builds the read-only investigation prompt for ONE angle. The CLI feeds this to a
 * read-only agent together with {@link SCOPE_FRAGMENT_SCHEMA} (schema-forced output). */
export function buildScopeExplorePrompt(task: string, angle: ScopeAngle): string {
  return [
    'You are a READ-ONLY code explorer. Investigate ONLY by reading / listing / searching —',
    'never write, patch, or run anything. Find out, for the task below and your assigned area:',
    `  - subsystem: "${angle.subsystem}"`,
    `  - question: ${angle.question}`,
    'Report the relevant files (path or path:line), what ALREADY EXISTS, what the task still NEEDS',
    'here, and any risks/unknowns. Be concrete and grounded in the actual code.',
    '',
    buildSchemaInstruction(SCOPE_FRAGMENT_SCHEMA),
    '',
    `Task: ${task}`,
  ].join('\n');
}

/** A fragment that found NOTHING (no exists/missing prose) — dropped, not merged,
 * so it never inflates the map or defeats scopeTask's all-fail→null guard. A
 * reasoning model that returns a schema-VALID but empty-string object hits this
 * too; the check is applied on BOTH the strict and coercion paths so they cannot
 * diverge. */
function fragmentIsEmpty(whatExists: string, whatsMissing: string): boolean {
  return whatExists.trim().length === 0 && whatsMissing.trim().length === 0;
}

/** Coerces an unknown value into a {@link ScopeFragment} (schema-validated); null on a
 * structurally-invalid OR findings-empty value so a useless explorer reply is dropped,
 * not half-merged (a schema-valid all-empty object is dropped exactly like a loose one). */
export function parseScopeFragment(
  modelOutput: string,
  fallbackSubsystem: string,
): ScopeFragment | null {
  const obj = firstJsonObject(modelOutput);
  if (obj === null) return null;
  // One coercion path for BOTH the schema-valid and close-but-loose cases: a
  // schema-valid object already carries string fields, so reading them via the
  // safe `typeof` guard is identical to trusting the schema — and it cannot
  // diverge from the coercion path on the empty-findings drop.
  const subsystem =
    typeof obj['subsystem'] === 'string' && obj['subsystem'].length > 0
      ? obj['subsystem']
      : fallbackSubsystem;
  const whatExists = typeof obj['whatExists'] === 'string' ? obj['whatExists'] : '';
  const whatsMissing = typeof obj['whatsMissing'] === 'string' ? obj['whatsMissing'] : '';
  if (fragmentIsEmpty(whatExists, whatsMissing)) return null;
  return {
    subsystem,
    files: toStringArray(obj['files']),
    whatExists,
    whatsMissing,
    risks: toStringArray(obj['risks']),
  };
}

/** Builds the synthesis prompt: merge the per-angle fragments into one ScopeMap.
 * Sends a COMPACT projection of each fragment (subsystem + what exists/missing +
 * risks — NOT the verbose `files` lists) so a reasoning model has the headroom to
 * actually emit the JSON instead of spending its whole budget reading file paths. */
export function buildScopeSynthesisPrompt(task: string, fragments: ScopeFragment[]): string {
  const compact = fragments.map((f) => ({
    subsystem: f.subsystem,
    whatExists: f.whatExists,
    whatsMissing: f.whatsMissing,
    risks: f.risks,
  }));
  return [
    'Synthesize these read-only exploration fragments into ONE scope map for the task.',
    'FIRST write a concise 1-2 sentence summary of the territory (this field is REQUIRED and',
    'must never be empty), then merge overlapping concerns into the TOP cross-cutting risks,',
    'and the open questions that would still change the plan. Respond with ONLY compact JSON:',
    '{"summary":"...","risks":["..."],"openQuestions":["..."]} — no prose, no fence, no markdown.',
    '',
    `Task: ${task}`,
    '',
    `Fragments: ${JSON.stringify(compact)}`,
  ].join('\n');
}

/** Builds the final {@link ScopeMap} from the synthesis output + the fragments. */
export function parseScopeMap(
  modelOutput: string,
  task: string,
  fragments: ScopeFragment[],
): ScopeMap {
  const obj = firstJsonObject(modelOutput);
  return {
    task,
    summary: obj !== null && typeof obj['summary'] === 'string' ? obj['summary'] : '',
    subsystems: fragments,
    risks: obj !== null ? toStringArray(obj['risks']) : [],
    openQuestions: obj !== null ? toStringArray(obj['openQuestions']) : [],
  };
}

/** A progress beat from {@link scopeTask} (for a live TTY / dashboard / SSE). */
export interface ScopeProgress {
  phase: 'decompose' | 'explore' | 'synthesize';
  /** On 'decompose': how many angles will be explored. */
  angleCount?: number;
  /** On 'explore': the subsystem whose explorer just finished. */
  subsystem?: string;
}

/** Injected dependencies for {@link scopeTask}. */
export interface ScopeDeps {
  /** The model for decompose + synthesize (multilingual; never keyword logic). */
  classify: IntentModel;
  /** Runs ONE read-only exploration of an angle → a fragment (the CLI backs this
   * with a read-only agent). Returns null when the explorer found nothing / failed. */
  explore: (task: string, angle: ScopeAngle, signal?: AbortSignal) => Promise<ScopeFragment | null>;
  /** Complexity hint (drives the angle count); defaults to 'medium'. */
  complexity?: ScopeComplexity;
  /** Override the auto-dimensioned angle count (still hard-capped). */
  maxAngles?: number;
  /** Optional progress sink (decompose → explore×N → synthesize). Never throws the flow. */
  onProgress?: (progress: ScopeProgress) => void;
  signal?: AbortSignal;
}

/**
 * Scopes a task: decompose → fan out READ-ONLY explorers (in parallel) → synthesize
 * → {@link ScopeMap}. Returns null when there is nothing to scope (empty task) or the
 * model can't decompose. A failing explorer drops to null and is skipped — a partial
 * map still ships. Never throws.
 */
export async function scopeTask(task: string, deps: ScopeDeps): Promise<ScopeMap | null> {
  const trimmed = task.trim();
  if (trimmed.length === 0) return null;

  // Clamp ALWAYS against ANGLE_HARD_CAP — even an injected `maxAngles` (the docstring
  // promises "still hard-capped"). Keeps the fan-out bounded for programmatic callers
  // (AO9-3 proactive, AO9-4 dashboard) that bypass the CLI's own 1-8 validation.
  const requested = deps.maxAngles ?? scopeAngleCount({ complexity: deps.complexity ?? 'medium' });
  const maxAngles = Math.max(1, Math.min(requested, ANGLE_HARD_CAP));

  let angles: ScopeAngle[];
  try {
    angles = parseScopeAngles(
      await deps.classify(buildScopeAnglesPrompt(trimmed, maxAngles), deps.signal),
    );
  } catch {
    return null;
  }
  angles = angles.slice(0, maxAngles);
  if (angles.length === 0) return null;
  emitProgress(deps, { phase: 'decompose', angleCount: angles.length });

  // Fan out the read-only explorers in parallel; a thrown/failed explorer → null.
  const settled = await Promise.all(
    angles.map((a) =>
      deps
        .explore(trimmed, a, deps.signal)
        .catch(() => null)
        .then((fragment) => {
          emitProgress(deps, { phase: 'explore', subsystem: a.subsystem });
          return fragment;
        }),
    ),
  );
  const found = settled.filter((f): f is ScopeFragment => f !== null);
  if (found.length === 0) return null;
  // Merge fragments that landed on the same subsystem (two angles can collide) so
  // the map has ONE section per subsystem and the user-facing count is accurate —
  // honouring the "deduped/merged" contract on ScopeMap.subsystems.
  const fragments = mergeFragmentsBySubsystem(found);
  emitProgress(deps, { phase: 'synthesize' });

  try {
    return parseScopeMap(
      await deps.classify(buildScopeSynthesisPrompt(trimmed, fragments), deps.signal),
      trimmed,
      fragments,
    );
  } catch {
    // Synthesis fault → a minimal map straight from the fragments (still useful).
    return { task: trimmed, summary: '', subsystems: fragments, risks: [], openQuestions: [] };
  }
}

/** Merges fragments sharing a subsystem (case-insensitively) into one: unions the
 * files + risks (dedup, order-preserving) and joins distinct exists/missing prose.
 * One section per subsystem; the first occurrence's casing/order wins. Pure. */
export function mergeFragmentsBySubsystem(fragments: ScopeFragment[]): ScopeFragment[] {
  const byKey = new Map<string, ScopeFragment>();
  for (const f of fragments) {
    const key = f.subsystem.trim().toLowerCase();
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, { ...f, files: [...f.files], risks: [...f.risks] });
      continue;
    }
    existing.files = dedupe([...existing.files, ...f.files]);
    existing.risks = dedupe([...existing.risks, ...f.risks]);
    existing.whatExists = joinDistinct(existing.whatExists, f.whatExists);
    existing.whatsMissing = joinDistinct(existing.whatsMissing, f.whatsMissing);
  }
  return [...byKey.values()];
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** Joins two prose blocks, skipping empties and exact duplicates. */
function joinDistinct(a: string, b: string): string {
  const left = a.trim();
  const right = b.trim();
  if (right.length === 0 || left === right) return left;
  if (left.length === 0) return right;
  return `${left}\n\n${right}`;
}

/** Renders a {@link ScopeMap} as readable Markdown (for the TTY / a report). Pure. */
export function scopeMapToMarkdown(map: ScopeMap): string {
  const lines: string[] = [`# Scope — ${map.task}`, ''];
  if (map.summary.length > 0) lines.push(map.summary, '');
  for (const s of map.subsystems) {
    lines.push(`## ${s.subsystem}`);
    if (s.files.length > 0) lines.push(`- Files: ${s.files.join(', ')}`);
    if (s.whatExists.length > 0) lines.push(`- Exists: ${s.whatExists}`);
    if (s.whatsMissing.length > 0) lines.push(`- Missing: ${s.whatsMissing}`);
    for (const r of s.risks) lines.push(`- ⚠ ${r}`);
    lines.push('');
  }
  if (map.risks.length > 0) {
    lines.push('## Risks', ...map.risks.map((r) => `- ${r}`), '');
  }
  if (map.openQuestions.length > 0) {
    lines.push('## Open questions', ...map.openQuestions.map((q) => `- ${q}`), '');
  }
  return lines.join('\n').trimEnd() + '\n';
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

/** Emits a progress beat; a throwing sink must never break the read-only flow. */
function emitProgress(deps: ScopeDeps, progress: ScopeProgress): void {
  if (deps.onProgress === undefined) return;
  try {
    deps.onProgress(progress);
  } catch {
    // A misbehaving progress sink is non-fatal — scoping continues.
  }
}
