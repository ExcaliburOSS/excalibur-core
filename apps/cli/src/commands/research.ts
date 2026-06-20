import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { runResearchFlow } from '../lib/research';

/**
 * `excalibur research "<question>"` — native deep web research with cited,
 * verified sources. Free by default (SearXNG → DuckDuckGo + native fetch);
 * runs the multi-agent pipeline: plan → search → fetch → adversarial verify →
 * cited synthesis. Governed by the network policy + SSRF floor.
 */
export function registerResearchCommand(program: Command, deps: CliDeps): void {
  program
    .command('research')
    .description('deep web research with cited, verified sources (free: SearXNG → DuckDuckGo)')
    .argument('<question...>', 'the research question')
    .option('--json', 'machine-readable JSON output')
    .option('-n, --max-sources <n>', 'maximum sources to fetch')
    .action(async (question: string[], options: { json?: boolean; maxSources?: string }) => {
      const max =
        options.maxSources !== undefined && Number.isFinite(Number(options.maxSources))
          ? Math.max(1, Math.floor(Number(options.maxSources)))
          : undefined;
      await runResearchFlow(deps, question.join(' '), {
        json: options.json === true,
        ...(max !== undefined ? { maxSources: max } : {}),
      });
    });
}
