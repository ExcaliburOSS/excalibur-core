import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDeps, type CliDeps } from './deps';
import { registerApplyCommand } from './commands/apply';
import { registerAskCommand } from './commands/ask';
import { registerBranchCommand } from './commands/branch';
import { registerCmuxCommand } from './commands/cmux';
import { registerDailyCommand } from './commands/daily';
import { registerDiscoveryCommand } from './commands/discovery';
import { registerDoctorCommand } from './commands/doctor';
import { registerExplainCommand } from './commands/explain';
import { registerExtensionsCommand } from './commands/extensions';
import { registerInitCommand } from './commands/init';
import { registerNewCommand } from './commands/new';
import { registerInstructionsCommand } from './commands/instructions';
import { registerInsightsCommand } from './commands/insights';
import { registerBrowserCommand } from './commands/browser';
import { registerMcpCommand } from './commands/mcp';
import { registerResearchCommand } from './commands/research';
import { registerSearchCommand } from './commands/search';
import { registerWebCommand } from './commands/web';
import { registerServeCommand } from './commands/serve';
import { registerShareCommand } from './commands/share';
import { registerAcpCommand } from './commands/acp';
import { registerWorkItemsCommand } from './commands/work-items';
import { registerAgentsCommand } from './commands/agents';
import { registerLoginCommands } from './commands/login';
import { registerLogsCommand } from './commands/logs';
import { registerMethodologiesCommand } from './commands/methodologies';
import { registerModelsCommand } from './commands/models';
import { registerPatchCommand } from './commands/patch';
import { registerPrCommands } from './commands/pr';
import { registerRejectCommand } from './commands/reject';
import { registerReplayCommand } from './commands/replay';
import { registerChangesCommand } from './commands/changes';
import { registerThemeCommand } from './commands/theme';
import { registerPlansCommand } from './commands/plans';
import { registerVerifyCommand } from './commands/verify';
import { registerForkCommand, registerUndoCommand } from './commands/fork';
import { registerReviewCommand } from './commands/review';
import { registerMissionCommand } from './commands/mission';
import { registerRunCommand } from './commands/run';
import { registerSwarmCommand } from './commands/swarm';
import { registerExploreCommand } from './commands/explore';
import { registerOrchestrateCommand } from './commands/orchestrate';
import { registerScheduleCommand } from './commands/schedule';
import { registerOrchestrationCommand } from './commands/orchestration';
import { registerSkillsCommand } from './commands/skills';
import { registerStatusCommand } from './commands/status';
import { registerStatsCommand } from './commands/stats';
import { registerSessionCommand } from './commands/session';
import { registerUpdateCommand } from './commands/update';
import { registerWeeklyPlanCommand } from './commands/weekly-plan';
import { registerWorkflowsCommand } from './commands/workflows';

// Injected by tsup's `define` from package.json at build time, so the published
// binary's `--version` can never drift from the manifest again (it shipped as
// 0.1.0 while the package was 1.0.0). Undefined only in non-bundled dev/test
// runs (tsx/vitest), where the dev sentinel is shown.
declare const __CLI_VERSION__: string | undefined;
/** Dev/test fallback (not bundled): read the manifest next to this module so
 * CLI_VERSION is the real version even under tsx/vitest. */
function devVersion(): string {
  try {
    return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
      .version as string;
  } catch {
    return '0.0.0';
  }
}
export const CLI_VERSION: string =
  typeof __CLI_VERSION__ === 'string' ? __CLI_VERSION__ : devVersion();

/**
 * Builds the `excalibur` commander program (Build Contract §4.9). Commander
 * never exits the process itself (`exitOverride`); `main.ts` maps every
 * thrown error onto the contract exit codes (0/1/2).
 */
export function buildProgram(overrides: Partial<CliDeps> = {}): Command {
  const deps = defaultDeps(overrides);
  const program = new Command();

  program
    .name('excalibur')
    .description('Excalibur Core — local-first AI-assisted and agentic development')
    .version(CLI_VERSION)
    .exitOverride()
    .configureOutput({
      writeOut: (text: string): void => deps.ui.writeRaw(text),
      writeErr: (text: string): void => deps.ui.writeRaw(text),
    });

  registerInitCommand(program, deps);
  registerNewCommand(program, deps);
  registerAskCommand(program, deps);
  registerExplainCommand(program, deps);
  registerReviewCommand(program, deps);
  registerPatchCommand(program, deps);
  registerRunCommand(program, deps);
  registerMissionCommand(program, deps);
  registerSwarmCommand(program, deps);
  registerExploreCommand(program, deps);
  registerOrchestrateCommand(program, deps);
  registerOrchestrationCommand(program, deps);
  registerScheduleCommand(program, deps);
  registerStatusCommand(program, deps);
  registerStatsCommand(program, deps);
  registerSessionCommand(program, deps);
  registerLogsCommand(program, deps);
  registerInsightsCommand(program, deps);
  registerServeCommand(program, deps);
  registerShareCommand(program, deps);
  registerAcpCommand(program, deps);
  registerWorkItemsCommand(program, deps);
  registerAgentsCommand(program, deps);
  registerMcpCommand(program, deps);
  registerSearchCommand(program, deps);
  registerBrowserCommand(program, deps);
  registerWebCommand(program, deps);
  registerResearchCommand(program, deps);
  registerReplayCommand(program, deps);
  registerChangesCommand(program, deps);
  registerThemeCommand(program, deps);
  registerPlansCommand(program, deps);
  registerVerifyCommand(program, deps);
  registerForkCommand(program, deps);
  registerUndoCommand(program, deps);
  registerApplyCommand(program, deps);
  registerBranchCommand(program, deps);
  registerRejectCommand(program, deps);
  registerPrCommands(program, deps);
  registerCmuxCommand(program, deps);
  registerDoctorCommand(program, deps);
  registerWorkflowsCommand(program, deps);
  registerMethodologiesCommand(program, deps);
  registerModelsCommand(program, deps);
  registerDailyCommand(program, deps);
  registerWeeklyPlanCommand(program, deps);
  registerDiscoveryCommand(program, deps);
  registerLoginCommands(program, deps);
  registerExtensionsCommand(program, deps);
  registerInstructionsCommand(program, deps);
  registerSkillsCommand(program, deps);
  registerUpdateCommand(program, deps);

  return program;
}
