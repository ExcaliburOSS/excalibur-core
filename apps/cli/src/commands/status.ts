import { DiscoveryManager, InteractionStore, PatchStore, RunManager } from '@excalibur/core';
import type { Command } from 'commander';
import type { CliDeps } from '../deps';

/**
 * `excalibur status [--discovery] [--json]` — local runs table (latest
 * first), plus patch/interaction counts and the progressive-disclosure
 * suggestions after ≥5 runs (onboarding §9, informational only).
 */
export function registerStatusCommand(program: Command, deps: CliDeps): void {
  program
    .command('status')
    .description('show local runs (and discovery sessions with --discovery)')
    .option('--discovery', 'list local discovery sessions instead of runs')
    .option('--json', 'machine-readable JSON output')
    .action((options: { discovery?: boolean; json?: boolean }) => {
      const repoRoot = deps.cwd();

      if (options.discovery === true) {
        const sessions = new DiscoveryManager(repoRoot).listSessions();
        if (options.json === true) {
          deps.ui.json(sessions.map((session) => session.record));
          return;
        }
        if (sessions.length === 0) {
          deps.ui.info('No local discovery sessions. Start one with: excalibur discovery "<idea>"');
          return;
        }
        deps.ui.table(
          ['ID', 'TITLE', 'TYPE', 'STATUS', 'RECOMMENDATION'],
          sessions
            .slice()
            .reverse()
            .map((session) => [
              session.id,
              session.record.title.slice(0, 48),
              session.record.inputType,
              session.record.status,
              session.record.recommendation ?? '-',
            ]),
        );
        return;
      }

      const runs = new RunManager(repoRoot).listRuns();
      const patches = new PatchStore(repoRoot).list();
      const interactions = new InteractionStore(repoRoot).list();

      if (options.json === true) {
        deps.ui.json({
          runs: runs.map((run) => run.record),
          patches: patches.map((patch) => patch.metadata),
          interactions: interactions.map((interaction) => interaction.metadata),
        });
        return;
      }

      if (runs.length === 0) {
        deps.ui.info('No local runs yet. Start one with: excalibur run "<task>"');
      } else {
        deps.ui.table(
          ['ID', 'TITLE', 'WORKFLOW', 'LEVEL', 'STATUS', 'STARTED'],
          runs
            .slice()
            .reverse()
            .map((run) => [
              run.id,
              run.record.title.slice(0, 48),
              run.record.workflow,
              `L${run.record.autonomyLevel}`,
              run.record.status,
              run.record.startedAt,
            ]),
        );
        deps.ui.info('Rewind any run like a video: excalibur rewind <id>');
      }
      deps.ui.write();
      deps.ui.info(
        `Patches: ${patches.length} · Interactions: ${interactions.length} · Runs: ${runs.length}`,
      );

      // Progressive disclosure (onboarding §9): non-blocking suggestions.
      if (runs.length >= 5) {
        deps.ui.write();
        deps.ui.heading('Useful next steps:');
        deps.ui.write('  - Share team standards: excalibur init --team');
        deps.ui.write('  - Add custom instructions under .excalibur/instructions/');
        deps.ui.write(
          '  - Tighten rules for sensitive paths in .excalibur/config.yaml (autonomy.paths)',
        );
        deps.ui.write('  - Connect GitHub Issues and work items (arrives in M4)');
      }
    });
}
