import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plansDir, readPlan } from '@excalibur/core';
import type { AutonomyLevel } from '@excalibur/shared';
import { parse as parseYaml } from 'yaml';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { loadConfigContext, loadGatewayContext, requireConfiguredModel } from '../lib/context';
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

/**
 * `excalibur plans` — browse + resume saved plans in `.excalibur/plans/`. The
 * list (default) shows status/task/date; `resume` picks an unfinished plan back
 * up at its next step. The plan markdown + JSON sidecar are portable + re-runnable.
 */
export function registerPlansCommand(program: Command, deps: CliDeps): void {
  const plans = program
    .command('plans')
    .description('browse & resume saved plans (.excalibur/plans)');

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
}
