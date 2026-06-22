import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXCALIBUR_DIR } from '../config/load-config';

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
  let file = join(dir, `${base}.md`);
  for (let n = 2; existsSync(file); n += 1) {
    file = join(dir, `${base}-${n}.md`);
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

  const body = `# Plan: ${input.task}\n\n${input.planMarkdown.trim()}\n`;
  writeFileSync(file, `${frontmatter}${body}`, 'utf8');
  return file;
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
function parsePlanFile(id: string, content: string): StoredPlan | null {
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
    return parsePlanFile(id, readFileSync(file, 'utf8'));
  } catch {
    return null;
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
