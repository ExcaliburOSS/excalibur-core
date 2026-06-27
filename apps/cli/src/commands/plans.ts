import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  diffPlans,
  listPlans,
  planProgress,
  plansDir,
  readPlan,
  renderPlanDiff,
} from '@excalibur/core';
import type { AutonomyLevel } from '@excalibur/shared';
import { parse as parseYaml } from 'yaml';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { loadConfigContext, loadGatewayContext, requireConfiguredModel } from '../lib/context';
import { materializePlanIntoWorkItems } from '../lib/plan-work-items';
import { findResumablePlan, resumePlanTurn, type AgentTurnDeps } from '../session/agent-turn';

interface PlanFrontmatter {
  task?: string;
  status?: string;
  created?: string;
}

interface ResumeOptions {
  level?: string;
  yes?: boolean;
}

/** Pulls the leading `---`…`---` YAML frontmatter out of a plan markdown file. */
function frontmatter(md: string): PlanFrontmatter {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  if (m === null) {
    return {};
  }
  try {
    const parsed = parseYaml(m[1] ?? '') as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as PlanFrontmatter) : {};
  } catch {
    return {};
  }
}

const statusGlyph = (status: string | undefined): string =>
  status === 'executed' ? '✓' : status === 'approved' ? '◐' : status === 'cancelled' ? '⊘' : '○';

/** Parses an optional `--level <0-4>` into an AutonomyLevel (default 4 — full agentic). */
function parseLevel(value: string | undefined): AutonomyLevel {
  if (value === undefined) {
    return 4;
  }
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0 || n > 4) {
    throw new CliUsageError(`--level must be between 0 and 4 (got "${value}").`);
  }
  return n as AutonomyLevel;
}

/** Prints the saved plans, newest first, with status/task/date. */
function listPlansAction(deps: CliDeps): void {
  const dir = plansDir(deps.cwd());
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .reverse()
    : [];
  if (files.length === 0) {
    deps.ui.info(deps.t('plans.none'));
    return;
  }
  deps.ui.heading(deps.t('plans.heading', { count: files.length }));
  for (const file of files) {
    const fm = frontmatter(readFileSync(join(dir, file), 'utf8'));
    const date = (fm.created ?? '').slice(0, 10);
    const task = fm.task ?? file.replace(/\.md$/, '');
    deps.ui.write(`  ${statusGlyph(fm.status)}  ${pc.dim(date)}  ${task}`);
    deps.ui.write(`     ${pc.dim(file)}`);
  }
  deps.ui.write();
  deps.ui.info(deps.t('plans.footer'));
}

/**
 * `excalibur plans resume [id]` — pick an unfinished plan back up at its first
 * unfinished step (PLAN3). Defaults to the newest resumable plan. Drives the rest
 * step by step, checkpointing each, and marks the plan executed once complete.
 */
async function resumePlanAction(
  deps: CliDeps,
  id: string | undefined,
  options: ResumeOptions,
): Promise<void> {
  const repoRoot = deps.cwd();
  const plan = id !== undefined ? readPlan(repoRoot, id) : findResumablePlan(repoRoot);
  if (plan === null) {
    deps.ui.info(deps.t('plans.resume_none'));
    return;
  }

  const { config } = loadConfigContext(repoRoot);
  const gateway = loadGatewayContext(repoRoot);
  requireConfiguredModel(gateway, deps.t); // no mock fallback: a real LLM is required

  const turn: AgentTurnDeps = {
    deps,
    repoRoot,
    config,
    gateway: gateway.gateway,
    providerName: gateway.providerName,
    autonomyLevel: parseLevel(options.level),
    approvals: { auto: options.yes === true || !deps.ui.isInteractive() },
  };

  await resumePlanTurn(turn, plan.id);
}

const stepGlyph = (status: string): string =>
  status === 'done' ? '✓' : status === 'active' ? '▸' : status === 'blocked' ? '✗' : '○';

/**
 * `excalibur plans tasks [id]` — materialize a plan into the kanban as an epic +
 * per-step sub-tasks with dependency edges (PLAN2), then print the tree with each
 * step's work-item key. Idempotent (re-running never duplicates). Defaults to the
 * newest plan.
 */
function planTasksAction(deps: CliDeps, id: string | undefined): void {
  const repoRoot = deps.cwd();
  const plan = id !== undefined ? readPlan(repoRoot, id) : (listPlans(repoRoot)[0] ?? null);
  if (plan === null) {
    deps.ui.info(deps.t('plans.none'));
    return;
  }
  const { total } = planProgress(plan.plan);
  if (total === 0) {
    deps.ui.info(deps.t('plans.tasks_empty'));
    return;
  }

  const result = materializePlanIntoWorkItems(repoRoot, plan.id, plan.plan, plan.task);
  const epic = result.epicWorkItemId ?? plan.plan.epicWorkItemId ?? '—';
  deps.ui.heading(deps.t('plans.tasks_heading', { epic, task: plan.task }));
  for (const phase of plan.plan.phases) {
    if (phase.title.length > 0) {
      deps.ui.write(`  ${pc.bold(phase.title)}`);
    }
    for (const step of phase.steps) {
      const key = step.workItemId ?? '—';
      const deps_ = (step.deps ?? [])
        .map((d) => result.stepWorkItemIds[d])
        .filter((k): k is string => k !== undefined);
      const dep = deps_.length > 0 ? pc.dim(` ⟂ needs ${deps_.join(', ')}`) : '';
      deps.ui.write(`   ${stepGlyph(step.status)} ${pc.cyan(key)}  ${step.title}${dep}`);
    }
  }
  deps.ui.write();
  deps.ui.info(deps.t('plans.tasks_footer', { count: Object.keys(result.stepWorkItemIds).length }));
}

/** Colours one rendered plan-diff line by its leading change marker (PLAN7). */
function colorDiffLine(line: string): string {
  const trimmed = line.trimStart();
  const markColor: Partial<Record<string, (s: string) => string>> = {
    '+': pc.green,
    '−': pc.red,
    '~': pc.yellow,
    '→': pc.cyan,
  };
  const color = markColor[trimmed[0] ?? ''];
  return color !== undefined ? color(line) : line;
}

/**
 * `excalibur plans diff [idA] [idB]` — the structured re-plan diff (PLAN7): what
 * changed between two plan versions (steps added/removed/renamed/moved). Defaults to
 * the two newest plans (older → newer). Matches by title, so an inserted step doesn't
 * read as "everything after it changed".
 */
function planDiffAction(deps: CliDeps, idA: string | undefined, idB: string | undefined): void {
  const repoRoot = deps.cwd();
  let oldPlan;
  let newPlan;
  if (idA !== undefined && idB !== undefined) {
    oldPlan = readPlan(repoRoot, idA);
    newPlan = readPlan(repoRoot, idB);
  } else {
    const all = listPlans(repoRoot);
    if (all.length < 2) {
      deps.ui.info(deps.t('plans.diff_need_two'));
      return;
    }
    newPlan = all[0]; // newest
    oldPlan = all[1]; // previous
  }
  if (oldPlan == null || newPlan == null) {
    deps.ui.info(deps.t('plans.diff_missing'));
    return;
  }

  deps.ui.heading(deps.t('plans.diff_heading', { from: oldPlan.id, to: newPlan.id }));
  const diff = diffPlans(oldPlan.plan, newPlan.plan);
  for (const line of renderPlanDiff(diff)) {
    deps.ui.write(colorDiffLine(line));
  }
  // A compact phase-level note when phases themselves changed.
  const phaseChanges = diff.phases.filter((p) => p.change !== 'unchanged');
  if (phaseChanges.length > 0) {
    deps.ui.write();
    deps.ui.info(
      deps.t('plans.diff_phases', {
        changes: phaseChanges
          .map((p) =>
            p.change === 'renamed'
              ? `${p.oldTitle} → ${p.title}`
              : `${p.change[0]?.toUpperCase()}:${p.title}`,
          )
          .join(', '),
      }),
    );
  }
}

/**
 * `excalibur plans` — browse, resume, materialize, and diff saved plans in
 * `.excalibur/plans/`. `list` (default) shows status/task/date; `resume` picks an
 * unfinished plan up at its next step (PLAN3); `tasks` materializes the plan into
 * the kanban as an epic + sub-tasks (PLAN2); `diff` compares two plan versions
 * (PLAN7). The `.md` + JSON sidecar are portable.
 */
export function registerPlansCommand(program: Command, deps: CliDeps): void {
  const plans = program
    .command('plans')
    .description('browse, resume & materialize saved plans (.excalibur/plans)');

  plans
    .command('list', { isDefault: true })
    .description('list saved plans (newest first)')
    .action(() => listPlansAction(deps));

  plans
    .command('resume')
    .description('resume an unfinished plan at its next step')
    .argument('[id]', 'plan id (defaults to the newest resumable plan)')
    .option('--level <0-4>', 'autonomy level for the resumed run (default 4)')
    .option('-y, --yes', 'auto-approve the resumed run’s edits/commands (non-interactive)')
    .action((id: string | undefined, options: ResumeOptions) =>
      resumePlanAction(deps, id, options),
    );

  plans
    .command('tasks')
    .description('materialize a plan into the kanban (epic + sub-tasks + deps)')
    .argument('[id]', 'plan id (defaults to the newest plan)')
    .action((id: string | undefined) => planTasksAction(deps, id));

  plans
    .command('diff')
    .description('show what changed between two plan versions (PLAN7)')
    .argument('[idA]', 'the older plan id (defaults to the previous plan)')
    .argument('[idB]', 'the newer plan id (defaults to the newest plan)')
    .action((idA: string | undefined, idB: string | undefined) => planDiffAction(deps, idA, idB));
}
