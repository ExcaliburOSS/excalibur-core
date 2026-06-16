import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXCALIBUR_DIR,
  applyInitPlan,
  enrichAgentsMd,
  generateInitPlan,
  type InitMode,
  type InitPlan,
} from '@excalibur/core';
import { analyzeRepository, type RepoAnalysis } from '@excalibur/context-engine';
import type { Command } from 'commander';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import { loadGatewayContext, providersFilePath, safetyLine } from '../lib/context';
import { promptProviderSetup } from '../lib/provider-setup';

interface InitOptions {
  team?: boolean;
  full?: boolean;
  yes?: boolean;
  force?: boolean;
  enrich?: boolean;
}

/**
 * Best-effort M2 AGENTS.md enrichment: when a real model is configured and the
 * plan is generating a FRESH AGENTS.md (never an existing one — ISD), replace
 * its deterministic content with model-enriched prose. Routed to the MAIN model
 * (one-off doc quality matters). Any failure keeps the deterministic version.
 */
async function maybeEnrichAgentsMd(
  deps: CliDeps,
  repoRoot: string,
  analysis: RepoAnalysis,
  plan: InitPlan,
): Promise<void> {
  const agentsFile = plan.files.find((file) => file.relPath === 'AGENTS.md' && !file.exists);
  if (agentsFile === undefined) {
    return; // no fresh AGENTS.md to enrich (absent, or one already exists)
  }
  let gateway;
  try {
    gateway = loadGatewayContext(repoRoot);
  } catch {
    return;
  }
  if (!gateway.configured) {
    return; // no real model yet → keep the deterministic AGENTS.md
  }
  const providerType = (gateway.providers.providers as Record<string, { type?: string }>)[
    gateway.providerName
  ]?.type;
  if (providerType === 'mock') {
    return;
  }
  try {
    deps.ui.info('Enriching AGENTS.md with your model…');
    agentsFile.content = await enrichAgentsMd(analysis, {
      chat: gateway.gateway,
      provider: gateway.providerName,
    });
  } catch {
    // Keep the deterministic AGENTS.md — enrichment is additive, never blocking.
  }
}

/**
 * `excalibur init [--team|--full]` (onboarding spec §1–§5, §12):
 * analyze → optional one-question provider setup → plan → grouped detection
 * report → confirm → apply → the confidence-building final output.
 * Minimal mode by default; never overwrites silently (update mode + --force).
 */
export function registerInitCommand(program: Command, deps: CliDeps): void {
  program
    .command('init')
    .description('initialize .excalibur/ for this repository (minimal by default)')
    .option('--team', 'also generate shared team standards (instructions, policies, routing)')
    .option('--full', 'export every built-in catalog for inspection/customization')
    .option('--force', 'overwrite existing files (update mode otherwise)')
    .option('--no-enrich', 'skip AI enrichment of a freshly generated AGENTS.md')
    .option('-y, --yes', 'skip prompts and accept safe defaults')
    .action(async (options: InitOptions) => {
      if (options.team === true && options.full === true) {
        throw new CliUsageError('Use either --team or --full, not both.');
      }
      const mode: InitMode = options.full === true ? 'full' : options.team === true ? 'team' : 'minimal';
      const yes = options.yes === true;
      const repoRoot = deps.cwd();

      const analysis = await analyzeRepository(repoRoot, {
        homeDir: deps.homeDir(),
        includeUserGlobal: deps.includeUserGlobal,
      });

      // Optional one-question provider setup (onboarding §4) — only when
      // models are not configured yet; always skippable. `--yes` skips the
      // question entirely ("configure later"): the built-in mock is the M1
      // runtime default, so minimal init stays at exactly three files
      // (Build Contract §4.6). `excalibur models setup` configures later.
      let providers = undefined;
      if (!yes && !existsSync(providersFilePath(repoRoot))) {
        const chosen = await promptProviderSetup(deps, { yes });
        if (chosen !== null) {
          providers = chosen;
        }
      }

      const plan = generateInitPlan(analysis, {
        mode,
        ...(providers !== undefined ? { providers } : {}),
      });

      // M2: enrich a freshly-generated AGENTS.md with the model (best-effort).
      if (options.enrich !== false) {
        await maybeEnrichAgentsMd(deps, repoRoot, analysis, plan);
      }

      deps.ui.write();
      for (const line of plan.summaryLines) {
        deps.ui.write(line);
      }
      deps.ui.write();

      if (mode === 'team') {
        const versionInGit = await deps.ui.confirm('Version Excalibur config in Git?', {
          yes,
          defaultYes: true,
        });
        if (!versionInGit) {
          const gitignore = join(repoRoot, '.gitignore');
          const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
          if (!current.split('\n').includes(`${EXCALIBUR_DIR}/`)) {
            appendFileSync(gitignore, `${current.endsWith('\n') || current === '' ? '' : '\n'}${EXCALIBUR_DIR}/\n`, 'utf8');
            deps.ui.info(`Added ${EXCALIBUR_DIR}/ to .gitignore.`);
          }
        }
      }

      const updateMode = plan.files.some((file) => file.exists);
      const question = updateMode
        ? 'Some files already exist (see above). Apply the changes?'
        : 'Apply these changes?';
      const confirmed = await deps.ui.confirm(question, { yes, defaultYes: true });
      if (!confirmed) {
        deps.ui.info('Init cancelled — nothing was written.');
        return;
      }

      const result = applyInitPlan(repoRoot, plan, { overwrite: options.force === true });

      // Confidence-building final output (onboarding §8 / raw spec §12).
      deps.ui.write();
      deps.ui.heading('Detected:');
      deps.ui.write(
        `  ${[...analysis.languages, ...analysis.frameworks, analysis.packageManager ?? '']
          .filter((part) => part.length > 0)
          .join(' · ') || 'nothing specific — defaults apply'}`,
      );
      const commandsLine = Object.entries(analysis.commands)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([key, value]) => `${key}: ${value}`)
        .join(' · ');
      if (commandsLine.length > 0) {
        deps.ui.write(`  ${commandsLine}`);
      }

      const projectInstructions = analysis.instructionSources.filter(
        (source) => source.kind === 'instruction' && source.scope === 'project',
      );
      if (projectInstructions.length > 0) {
        deps.ui.heading('Using existing instructions:');
        for (const source of projectInstructions) {
          deps.ui.success(`  ${source.path}`);
        }
      }

      deps.ui.write(safetyLine({}));

      deps.ui.heading('Created:');
      for (const relPath of result.written) {
        deps.ui.write(`  + ${relPath}`);
      }
      if (result.skipped.length > 0) {
        deps.ui.info(
          `  Skipped ${result.skipped.length} existing file(s) — re-run with --force to overwrite.`,
        );
      }

      if (providers === undefined && !existsSync(providersFilePath(repoRoot))) {
        deps.ui.info(
          'No model provider configured yet — commands use the built-in mock provider (M1). ' +
            'Run `excalibur models setup` when ready.',
        );
      }

      deps.ui.heading('Try now:');
      deps.ui.write('  excalibur ask "How does this repo work?"');
      deps.ui.write('  excalibur review --diff');
      deps.ui.write('  excalibur patch "Fix duplicated webhook handling"');
      deps.ui.write('  excalibur run "Implement a small safe change"');
    });
}
