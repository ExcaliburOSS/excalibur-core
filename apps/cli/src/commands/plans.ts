import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plansDir } from '@excalibur/core';
import { parse as parseYaml } from 'yaml';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { CliDeps } from '../deps';

interface PlanFrontmatter {
  task?: string;
  status?: string;
  created?: string;
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

/**
 * `excalibur plans` — list the saved plans in `.excalibur/plans/` (newest first)
 * with their status, task and date. The plan markdown is portable + re-runnable;
 * this is the browse surface. Read-only, scriptable.
 */
export function registerPlansCommand(program: Command, deps: CliDeps): void {
  program
    .command('plans')
    .description('list saved plans (.excalibur/plans)')
    .action(() => {
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
    });
}
