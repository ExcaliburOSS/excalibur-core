import {
  SprintStore,
  computeBurndown,
  type Burndown,
  type BurndownItem,
  type Sprint,
} from '@excalibur/core';
import { LocalWorkItemProvider, laneOf, type NormalizedWorkItem } from '@excalibur/work-items';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

interface CreateOpts {
  start?: string;
  end?: string;
  goal?: string;
  json?: boolean;
}

/** All local work-items assigned to a sprint (`cycleOrSprint === sprintId`). */
async function sprintItems(repoRoot: string, sprintId: string): Promise<NormalizedWorkItem[]> {
  const all = await new LocalWorkItemProvider(repoRoot).listWorkItems({ integrationId: 'local' });
  return all.filter((w) => w.cycleOrSprint === sprintId);
}

/** Projects a work-item into a burndown item (points = estimate or 1; done = in the
 * `done` lane, dated from `updatedAt` since the store keeps no completion history). */
function toBurndownItem(item: NormalizedWorkItem): BurndownItem {
  const done = laneOf(item.status) === 'done';
  return {
    points: item.estimate ?? 1,
    doneDate: done ? (item.updatedAt ?? '').slice(0, 10) || null : null,
  };
}

/** A tiny sparkline of remaining points over the sprint days. */
function sparkline(values: number[]): string {
  const max = Math.max(1, ...values);
  return values
    .map((v) => SPARK[Math.min(SPARK.length - 1, Math.round((v / max) * (SPARK.length - 1)))])
    .join('');
}

const statusGlyph = (s: Sprint['status']): string =>
  s === 'active' ? '▸' : s === 'completed' ? '✓' : '○';

function requireDate(deps: CliDeps, label: string, value: string | undefined): string {
  if (value === undefined || !DATE_RE.test(value)) {
    throw new CliUsageError(deps.t('sprints.bad_date', { label, value: value ?? '' }));
  }
  return value;
}

function findSprint(deps: CliDeps, store: SprintStore, id: string): Sprint {
  const sprint = store.getSprint(id);
  if (sprint === null) {
    throw new CliUsageError(deps.t('sprints.not_found', { id }));
  }
  return sprint;
}

/**
 * `excalibur sprints` — the native agile backlog layer (PLAN5): time-boxed sprints
 * with story-point estimates and a burndown. Subcommands: list · create · start ·
 * complete · assign · show (with an ASCII burndown). Read-only ones honour `--json`.
 */
export function registerSprintsCommand(program: Command, deps: CliDeps): void {
  const sprints = program.command('sprints').description('plan & track sprints (PLAN5)');

  sprints
    .command('list', { isDefault: true })
    .description('list sprints (newest first)')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      const store = new SprintStore(deps.cwd());
      const all = store.listSprints();
      if (opts.json === true) {
        deps.ui.json(all);
        return;
      }
      if (all.length === 0) {
        deps.ui.info(deps.t('sprints.none'));
        return;
      }
      const rows: string[][] = [];
      for (const s of all) {
        const items = await sprintItems(deps.cwd(), s.id);
        const total = items.reduce((sum, i) => sum + (i.estimate ?? 1), 0);
        const done = items
          .filter((i) => laneOf(i.status) === 'done')
          .reduce((sum, i) => sum + (i.estimate ?? 1), 0);
        rows.push([
          `${statusGlyph(s.status)} ${s.id}`,
          s.name,
          deps.t('sprints.status.' + s.status),
          `${s.startDate} → ${s.endDate}`,
          `${items.length}`,
          `${done}/${total}`,
        ]);
      }
      deps.ui.table(
        [
          deps.t('sprints.col_id'),
          deps.t('sprints.col_name'),
          deps.t('sprints.col_status'),
          deps.t('sprints.col_window'),
          deps.t('sprints.col_items'),
          deps.t('sprints.col_points'),
        ],
        rows,
      );
    });

  sprints
    .command('create')
    .description('create a sprint')
    .argument('<name...>', 'the sprint name')
    .option('--start <YYYY-MM-DD>', 'start date (inclusive)')
    .option('--end <YYYY-MM-DD>', 'end date (inclusive)')
    .option('--goal <text>', 'the sprint goal / theme')
    .option('--json', 'machine-readable output')
    .action((nameWords: string[], opts: CreateOpts) => {
      const name = nameWords.join(' ').trim();
      if (name.length === 0) {
        throw new CliUsageError(deps.t('sprints.needs_name'));
      }
      const startDate = requireDate(deps, '--start', opts.start);
      const endDate = requireDate(deps, '--end', opts.end);
      const sprint = new SprintStore(deps.cwd()).createSprint({
        name,
        startDate,
        endDate,
        ...(opts.goal !== undefined ? { goal: opts.goal } : {}),
      });
      if (opts.json === true) {
        deps.ui.json(sprint);
        return;
      }
      deps.ui.success(deps.t('sprints.created', { id: sprint.id, name: sprint.name }));
    });

  sprints
    .command('start')
    .description('mark a sprint active')
    .argument('<id>', 'sprint id')
    .action((id: string) => {
      const store = new SprintStore(deps.cwd());
      findSprint(deps, store, id);
      store.updateSprint(id, { status: 'active' });
      deps.ui.success(deps.t('sprints.started', { id }));
    });

  sprints
    .command('complete')
    .description('mark a sprint completed')
    .argument('<id>', 'sprint id')
    .action((id: string) => {
      const store = new SprintStore(deps.cwd());
      findSprint(deps, store, id);
      store.updateSprint(id, { status: 'completed' });
      deps.ui.success(deps.t('sprints.completed', { id }));
    });

  sprints
    .command('assign')
    .description('assign work-items to a sprint')
    .argument('<id>', 'sprint id')
    .argument('<keys...>', 'work-item keys (WI-n)')
    .action((id: string, keys: string[]) => {
      const store = new SprintStore(deps.cwd());
      findSprint(deps, store, id);
      const provider = new LocalWorkItemProvider(deps.cwd());
      let assigned = 0;
      for (const key of keys) {
        try {
          provider.updateWorkItem(key, { cycleOrSprint: id });
          assigned += 1;
        } catch {
          deps.ui.warn(deps.t('sprints.assign_failed', { key }));
        }
      }
      deps.ui.success(deps.t('sprints.assigned', { count: assigned, id }));
    });

  sprints
    .command('show')
    .description('a sprint with its work-items + a burndown')
    .argument('<id>', 'sprint id')
    .option('--json', 'machine-readable output')
    .action(async (id: string, opts: { json?: boolean }) => {
      const store = new SprintStore(deps.cwd());
      const sprint = findSprint(deps, store, id);
      const items = await sprintItems(deps.cwd(), id);
      const burndown: Burndown = computeBurndown(
        sprint.startDate,
        sprint.endDate,
        items.map(toBurndownItem),
      );
      if (opts.json === true) {
        deps.ui.json({ sprint, items, burndown });
        return;
      }

      deps.ui.heading(`${statusGlyph(sprint.status)} ${sprint.id} · ${sprint.name}`);
      if (sprint.goal !== null) {
        deps.ui.write(`  ${pc.dim(sprint.goal)}`);
      }
      deps.ui.write(
        `  ${sprint.startDate} → ${sprint.endDate} · ${deps.t('sprints.status.' + sprint.status)}`,
      );
      deps.ui.write(
        `  ${deps.t('sprints.points_summary', { done: burndown.donePoints, total: burndown.totalPoints, items: burndown.itemCount })}`,
      );
      if (burndown.days.length > 0) {
        deps.ui.write();
        deps.ui.write(`  ${deps.t('sprints.burndown')}`);
        deps.ui.write(`  ${pc.cyan(sparkline(burndown.days.map((d) => d.remaining)))}`);
        const last = burndown.days[burndown.days.length - 1];
        deps.ui.write(
          `  ${pc.dim(`${burndown.days[0]?.date} … ${last?.date} · ${deps.t('sprints.remaining', { n: last?.remaining ?? 0 })}`)}`,
        );
      }
      deps.ui.write();
      if (items.length === 0) {
        deps.ui.info(deps.t('sprints.no_items'));
        return;
      }
      for (const item of items) {
        const lane = laneOf(item.status);
        const glyph = lane === 'done' ? '✓' : lane === 'in_progress' ? '▸' : '○';
        const pts = pc.dim(`${item.estimate ?? 1}pt`);
        deps.ui.write(`  ${glyph} ${pc.cyan(item.key)}  ${item.title}  ${pts}`);
      }
    });
}
