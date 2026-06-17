import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
