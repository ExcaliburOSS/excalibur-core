import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXCALIBUR_DIR } from '../config/load-config';
import {
  findStep,
  isStructuredPlan,
  nextPendingStep,
  parsePlanMarkdown,
  renderPlanMarkdown,
  type PlanStepStatus,
  type StructuredPlan,
} from './plan-model';

// Aliased at the boundary: the orchestrator (capability DAG) already exports a
// `PlanStep`/`PlanPhase`, so the STRUCTURED-PLAN step/phase types are surfaced as
// `StructuredPlanStep`/`StructuredPlanPhase` to avoid a name clash in @excalibur/core.
export type {
  PlanStep as StructuredPlanStep,
  PlanStepStatus,
  PlanPhase as StructuredPlanPhase,
  StructuredPlan,
} from './plan-model';
export {
  parsePlanMarkdown,
  renderPlanMarkdown,
  planProgress,
  nextPendingStep,
  findStep,
  isStructuredPlan,
} from './plan-model';

/**
 * The PLANS folder — approved plans are persisted as portable markdown at
 * `.excalibur/plans/<stamp>-<slug>.md` (with YAML frontmatter), so a mega-plan
 * survives the session, is shareable/reviewable, and can be re-run later.
 * Neither Claude Code nor OpenCode persist plans to a folder — this is a
 * deliberate beat. The same plan is also promoted to project memory
 * (Knowledge Compounding) by the caller.
 */

export type PlanStatus = 'proposed' | 'approved' | 'executed' | 'cancelled';

export interface SavePlanInput {
  /** The task the plan addresses (becomes the slug + title). */
  task: string;
  /** The plan body (markdown — numbered phases/subphases as produced). */
  planMarkdown: string;
  /**
   * The STRUCTURED plan (source of truth). When provided, the `.md` body is
   * rendered FROM it; otherwise it is derived from `planMarkdown`. Either way it
   * is persisted as the `<id>.plan.json` sidecar.
   */
  plan?: StructuredPlan;
  status: PlanStatus;
  /** The (replayable) plan run id. */
  planRunId: string;
  /** The execution run id, once the plan was executed. */
  execRunId?: string;
  /** Injected for deterministic filenames/timestamps in tests. */
  now?: Date;
}

/** Absolute path to the repo's plans folder. */
export function plansDir(repoRoot: string): string {
  return join(repoRoot, EXCALIBUR_DIR, 'plans');
}

/** A filesystem-safe slug from a task title (lowercase, dash-joined, capped). */
export function slugify(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'plan';
}

/** `YYYYMMDD-HHMMSS` from a Date (local time), for a sortable filename prefix. */
function stamp(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

function yamlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Writes the plan to `.excalibur/plans/<stamp>-<slug>.md` and returns the path.
 * Frontmatter carries task/status/run ids/timestamp so the plan is a queryable,
 * re-runnable artifact (not just prose in a transcript like CC).
 */
export function savePlan(repoRoot: string, input: SavePlanInput): string {
  const now = input.now ?? new Date();
  const base = `${stamp(now)}-${slugify(input.task)}`;
  const dir = plansDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  // Never overwrite a prior plan that landed in the same second with the same
  // slug — disambiguate with a numeric suffix.
  let name = base;
  let file = join(dir, `${name}.md`);
  for (let n = 2; existsSync(file); n += 1) {
    name = `${base}-${n}`;
    file = join(dir, `${name}.md`);
  }

  const frontmatter = [
    '---',
    `task: "${yamlEscape(input.task)}"`,
    `status: ${input.status}`,
    `planRun: ${input.planRunId}`,
    ...(input.execRunId !== undefined ? [`execRun: ${input.execRunId}`] : []),
    `created: ${now.toISOString()}`,
    '---',
    '',
  ].join('\n');

  // The structured plan is the source of truth: use the provided structure, or
  // derive one from the prose so even a plain-markdown plan gets a queryable shape.
  const structured = input.plan ?? parsePlanMarkdown(input.planMarkdown);
  const bodyMarkdown =
    input.plan !== undefined ? renderPlanMarkdown(input.plan) : input.planMarkdown.trim();
  const body = `# Plan: ${input.task}\n\n${bodyMarkdown}\n`;
  writeFileSync(file, `${frontmatter}${body}`, 'utf8');
  // Sidecar: the machine-addressable phases/steps/status next to the human .md.
  writeFileSync(join(dir, `${name}.plan.json`), `${JSON.stringify(structured, null, 2)}\n`, 'utf8');
  return file;
}

/** Absolute path to a plan's structured sidecar (`<id>.plan.json`). */
export function planSidecarPath(repoRoot: string, id: string): string {
  return join(plansDir(repoRoot), `${id}.plan.json`);
}

/**
 * Overwrites a plan's structured sidecar with `plan` (the source of truth). Used
 * after the plan materializer (PLAN2) stamps `workItemId`/`epicWorkItemId` onto the
 * in-memory plan, so the links survive. Returns false on an unsafe/unknown id.
 */
export function writePlanSidecar(repoRoot: string, id: string, plan: StructuredPlan): boolean {
  if (id.length === 0 || id.includes('/') || id.includes('\\') || id.includes('..')) {
    return false;
  }
  const file = planSidecarPath(repoRoot, id);
  if (!existsSync(file)) {
    return false;
  }
  try {
    writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Reads & validates a plan's structured sidecar, or null when absent/corrupt. */
function readSidecar(repoRoot: string, id: string): StructuredPlan | null {
  const file = planSidecarPath(repoRoot, id);
  if (!existsSync(file)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isStructuredPlan(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A parsed plan artifact (frontmatter + markdown body), as read back from disk. */
export interface StoredPlan {
  /** The filename without `.md` — the stable plan id (e.g. `20260622-101500-ship-d3`). */
  id: string;
  task: string;
  status: PlanStatus;
  planRun: string | null;
  execRun: string | null;
  /** ISO timestamp from the frontmatter, or null if absent/unparseable. */
  created: string | null;
  /** The markdown body (without the frontmatter block). */
  body: string;
  /**
   * The STRUCTURED plan (phases/steps/status/deps) — read from the `<id>.plan.json`
   * sidecar (source of truth) when present, else derived from the markdown body for
   * back-compat with plans written before the structured model.
   */
  plan: StructuredPlan;
}

const PLAN_STATUSES: ReadonlySet<string> = new Set([
  'proposed',
  'approved',
  'executed',
  'cancelled',
]);

/** Unescapes a YAML double-quoted scalar as written by {@link savePlan}. */
function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return trimmed;
}

/** Splits a plan file into its (simple) frontmatter map and the body markdown. */
function parsePlanFile(id: string, content: string): Omit<StoredPlan, 'plan'> | null {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  if (match === null) {
    return null; // not a frontmatter doc → skip
  }
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const kv = /^([a-zA-Z]+):\s*(.*)$/.exec(line);
    if (kv !== null) {
      fields[kv[1] as string] = kv[2] as string;
    }
  }
  const statusRaw = (fields['status'] ?? '').trim();
  const status: PlanStatus = PLAN_STATUSES.has(statusRaw) ? (statusRaw as PlanStatus) : 'proposed';
  return {
    id,
    task: fields['task'] !== undefined ? unquote(fields['task']) : id,
    status,
    planRun: fields['planRun'] !== undefined ? fields['planRun'].trim() : null,
    execRun: fields['execRun'] !== undefined ? fields['execRun'].trim() : null,
    created: fields['created'] !== undefined ? fields['created'].trim() : null,
    body: (match[2] ?? '').trim(),
  };
}

/**
 * Reads one plan by id (filename without `.md`), or null if it does not exist /
 * is not a valid plan doc. The id is confined to a single path segment so it
 * can never escape the plans folder.
 */
export function readPlan(repoRoot: string, id: string): StoredPlan | null {
  if (id.length === 0 || id.includes('/') || id.includes('\\') || id.includes('..')) {
    return null;
  }
  const file = join(plansDir(repoRoot), `${id}.md`);
  if (!existsSync(file)) {
    return null;
  }
  try {
    const base = parsePlanFile(id, readFileSync(file, 'utf8'));
    if (base === null) {
      return null;
    }
    // The sidecar JSON is the source of truth; fall back to deriving the structure
    // from the prose body for plans written before the structured model.
    const plan = readSidecar(repoRoot, id) ?? parsePlanMarkdown(base.body);
    return { ...base, plan };
  } catch {
    return null;
  }
}

/**
 * Updates ONE step's status (and optionally the run that executed it) in a plan's
 * structured sidecar — the durable state a resume reads to continue at the right
 * step. Creates the sidecar from the derived structure if a plan predates it.
 * Returns false when the plan or step does not exist. Never throws on IO.
 */
export function updatePlanStep(
  repoRoot: string,
  id: string,
  stepId: string,
  status: PlanStepStatus,
  runId?: string,
): boolean {
  const stored = readPlan(repoRoot, id);
  if (stored === null) {
    return false;
  }
  const hit = findStep(stored.plan, stepId);
  if (hit === null) {
    return false;
  }
  hit.step.status = status;
  if (runId !== undefined) {
    hit.step.runId = runId;
  }
  try {
    writeFileSync(
      planSidecarPath(repoRoot, id),
      `${JSON.stringify(stored.plan, null, 2)}\n`,
      'utf8',
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Lists all saved plans, NEWEST FIRST (the `<stamp>-<slug>` filenames sort
 * chronologically, so a reverse lexical sort is newest-first). Never throws — a
 * missing folder or an unparseable file is skipped.
 */
export function listPlans(repoRoot: string): StoredPlan[] {
  const dir = plansDir(repoRoot);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return []; // no plans folder yet
  }
  names.sort((a, b) => b.localeCompare(a)); // newest first
  const plans: StoredPlan[] = [];
  for (const name of names) {
    const id = name.slice(0, -'.md'.length);
    const plan = readPlan(repoRoot, id);
    if (plan !== null) {
      plans.push(plan);
    }
  }
  return plans;
}

/**
 * Updates the plan's OVERALL status (the `.md` frontmatter) — e.g. flip `approved`
 * → `executed` once every step is done. Rewrites just the `status:` line. Returns
 * false when the plan does not exist or has no parseable frontmatter status.
 */
export function setPlanStatus(repoRoot: string, id: string, status: PlanStatus): boolean {
  if (id.length === 0 || id.includes('/') || id.includes('\\') || id.includes('..')) {
    return false;
  }
  const file = join(plansDir(repoRoot), `${id}.md`);
  if (!existsSync(file)) {
    return false;
  }
  try {
    const lines = readFileSync(file, 'utf8').split('\n');
    let inFrontmatter = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i] === '---') {
        if (!inFrontmatter) {
          inFrontmatter = true;
          continue;
        }
        break; // end of frontmatter — `status:` was not found
      }
      if (inFrontmatter && /^status:\s*/.test(lines[i] ?? '')) {
        lines[i] = `status: ${status}`;
        writeFileSync(file, lines.join('\n'), 'utf8');
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Plans that are RESUMABLE: approved but not finished (a step is still pending),
 * newest first. The shell offers to pick these up where they left off (PLAN3).
 */
export function resumablePlans(repoRoot: string): StoredPlan[] {
  return listPlans(repoRoot).filter(
    (plan) => plan.status === 'approved' && nextPendingStep(plan.plan) !== null,
  );
}
