import { NativeAgentAdapter } from '@excalibur/agent-runtime';
import {
  RunManager,
  classifyTaskIntent,
  createExtensionHost,
  executeLocalRun,
  selectWorkflow,
  workflowCatalog,
  type TaskIntent,
} from '@excalibur/core';
import { analyzeRepository } from '@excalibur/context-engine';
import {
  AUTONOMY_LEVEL_LABELS,
  isAutonomyLevel,
  type AutonomyLevel,
  type ExcaliburEvent,
  type ExecutionStyle,
  type OutputType,
  outputTypeSchema,
} from '@excalibur/shared';
import type { WorkflowDefinition } from '@excalibur/workflow-schema';
import type { Command } from 'commander';
import pc from 'picocolors';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import {
  buildEffectiveContext,
  loadConfigContext,
  loadGatewayContext,
  safetyLine,
} from '../lib/context';
import { runDiscoveryFlow } from './discovery';
import { pushLatestRun } from './login';

interface RunOptions {
  level?: string;
  fast?: boolean;
  careful?: boolean;
  structured?: boolean;
  explore?: boolean;
  workflow?: string;
  output?: string;
  yes?: boolean;
  sync?: boolean;
}

interface RunChoice {
  autonomyLevel: AutonomyLevel;
  executionStyle: ExecutionStyle;
  workflowId: string;
  definition: WorkflowDefinition;
  reason: string;
}

function parseLevel(value: string | undefined): AutonomyLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!isAutonomyLevel(parsed)) {
    throw new CliUsageError(`--level must be 0..4 (got "${value}").`);
  }
  return parsed;
}

function parseOutput(value: string | undefined): OutputType | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = outputTypeSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliUsageError(
      `--output must be one of: ${outputTypeSchema.options.join(', ')} (got "${value}").`,
    );
  }
  return parsed.data;
}

function styleFromFlags(options: RunOptions): ExecutionStyle | undefined {
  const picked: ExecutionStyle[] = [];
  if (options.fast === true) picked.push('fast');
  if (options.careful === true) picked.push('careful');
  if (options.structured === true) picked.push('structured');
  if (options.explore === true) picked.push('explore');
  if (picked.length > 1) {
    throw new CliUsageError('Use at most one of --fast / --careful / --structured / --explore.');
  }
  return picked[0];
}

function defaultLevelForStyle(style: ExecutionStyle): AutonomyLevel {
  return style === 'careful' ? 4 : 3;
}

/** Compact terminal line for one streamed run event. */
export function describeEvent(event: ExcaliburEvent): string | null {
  const payload = event.payload;
  const str = (key: string): string => {
    const value = payload[key];
    return typeof value === 'string' ? value : '';
  };
  switch (event.type) {
    case 'run_started':
      return pc.bold('▶ run started');
    case 'workflow_selected':
      return pc.dim(`  workflow: ${str('workflow') || str('workflowId')}`);
    case 'methodology_selected':
      return pc.dim(`  methodology: ${str('methodology') || str('methodologyId')}`);
    case 'phase_started':
      return pc.cyan(`▶ ${str('name') || str('phaseId') || event.phaseId || 'phase'}`);
    case 'phase_completed':
      return pc.green(`✓ ${str('name') || str('phaseId') || event.phaseId || 'phase'} completed`);
    case 'assistant_message':
      return pc.dim('  assistant message');
    case 'model_call':
      return pc.dim(`  model call (${str('model') || 'mock'})`);
    case 'tool_call':
      return pc.dim(`  tool: ${str('tool') || str('name')}`);
    case 'file_read':
      return pc.dim(`  read ${str('path')}`);
    case 'file_write':
      return pc.dim(`  write ${str('path')} (simulated)`);
    case 'command_started':
      return pc.dim(`  $ ${str('command')} ${payload['simulated'] === true ? '(simulated)' : ''}`);
    case 'command_completed':
      return null;
    case 'test_result':
      return pc.green(`  tests: ${str('status') || 'passed'} ${payload['simulated'] === true ? '(simulated)' : ''}`);
    case 'patch_generated':
      return pc.yellow('  ± patch generated');
    case 'patch_applied':
      return pc.yellow('  ± patch applied (simulated)');
    case 'branch_created':
      return pc.yellow(`  branch: ${str('branch')}`);
    case 'approval_requested':
      return pc.yellow('  approval requested');
    case 'approval_approved':
      return pc.green('  approval granted');
    case 'approval_rejected':
      return pc.red('  approval rejected');
    case 'artifact_created':
      return pc.dim(`  artifact: ${str('fileName') || str('path')}`);
    case 'error':
      return pc.red(`  error: ${str('message')}`);
    case 'run_completed':
      return pc.bold(`■ run completed (${str('status') || 'completed'})`);
    default:
      return pc.dim(`  ${event.type}`);
  }
}

function printPlanPreview(deps: CliDeps, definition: WorkflowDefinition): void {
  deps.ui.write('Plan:');
  definition.phases.forEach((phase, index) => {
    const optional = phase.required === false ? pc.dim(' (optional)') : '';
    deps.ui.write(`  ${index + 1}. ${phase.name} ${pc.dim(`[${phase.type}]`)}${optional}`);
  });
}

/**
 * `excalibur run "<task>"` (Build Contract §4.9): classifyTaskIntent decides
 * the workflow, the prompt shows the choice with `[Enter] continue
 * [m] change mode [c] cancel`, every run prints the active safety preset,
 * then selectWorkflow → RunManager → executeLocalRun with the
 * NativeAgentAdapter + MockProvider, streaming events to the terminal.
 */
export function registerRunCommand(program: Command, deps: CliDeps): void {
  program
    .command('run')
    .description('run a local agentic workflow for a task (Level 3/4)')
    .argument('<task...>', 'the task to run')
    .option('--level <0-4>', 'autonomy level (0..4)')
    .option('--fast', 'fast execution style (fast-fix)')
    .option('--careful', 'careful execution style (Level 4, stronger approvals)')
    .option('--structured', 'structured execution style (structured-feature)')
    .option('--explore', 'explore engineering alternatives')
    .option('--workflow <id>', 'use an explicit workflow id')
    .option('--output <type>', 'desired output type (branch|pull_request|patch|review|plan|alternatives)')
    .option('--sync', 'push the finished run to Excalibur Enterprise (experimental)')
    .option('-y, --yes', 'skip prompts and accept safe defaults')
    .action(async (taskWords: string[], options: RunOptions) => {
      const task = taskWords.join(' ').trim();
      if (task.length === 0) {
        throw new CliUsageError('The task must not be empty.');
      }
      const repoRoot = deps.cwd();
      const yes = options.yes === true;

      const explicitLevel = parseLevel(options.level);
      parseOutput(options.output);
      const explicitStyle = styleFromFlags(options);

      const { config } = loadConfigContext(repoRoot);
      const analysis = await analyzeRepository(repoRoot, {
        homeDir: deps.homeDir(),
        includeUserGlobal: deps.includeUserGlobal,
      });
      const intent: TaskIntent = classifyTaskIntent(task, analysis, config);

      const registry = await createExtensionHost(repoRoot);
      const catalog = workflowCatalog(registry);

      // Ambiguous tasks: recommend Discovery first (onboarding §6) unless the
      // user pinned a workflow/level explicitly. When declined, the run
      // continues with the standard defaults (not the discovery workflow).
      let useIntentDefaults = true;
      if (
        intent.recommendDiscoveryFirst &&
        options.workflow === undefined &&
        explicitLevel === undefined &&
        explicitStyle === undefined
      ) {
        deps.ui.warn(intent.reason);
        const runDiscovery = await deps.ui.confirm('Run Discovery first?', {
          yes,
          defaultYes: !yes,
        });
        if (runDiscovery) {
          await runDiscoveryFlow(deps, { input: task, inputType: 'idea', yes });
          return;
        }
        deps.ui.info('Continuing without Discovery.');
        useIntentDefaults = false;
      }

      const choose = (style: ExecutionStyle | undefined, level: AutonomyLevel | undefined): RunChoice => {
        const executionStyle: ExecutionStyle = style ?? 'team_default';
        const autonomyLevel: AutonomyLevel =
          level ??
          (style !== undefined
            ? defaultLevelForStyle(style)
            : useIntentDefaults
              ? intent.recommendedAutonomy
              : 3);
        const intentDriven =
          useIntentDefaults &&
          options.workflow === undefined &&
          style === undefined &&
          level === undefined;
        const selected = selectWorkflow({
          config,
          catalog,
          autonomyLevel,
          executionStyle,
          taskType: intent.taskType,
          // The intent classifier drives the default choice (ONB-5).
          ...(options.workflow !== undefined
            ? { explicitWorkflow: options.workflow }
            : intentDriven
              ? { explicitWorkflow: intent.recommendedWorkflow }
              : {}),
        });
        const reason = intentDriven ? intent.reason : selected.reason;
        return {
          autonomyLevel,
          executionStyle,
          workflowId: selected.workflowId,
          definition: selected.definition,
          reason,
        };
      };

      let choice = choose(explicitStyle, explicitLevel);
      if (options.workflow !== undefined && choice.workflowId !== options.workflow) {
        throw new CliUsageError(
          `Unknown workflow "${options.workflow}". Run \`excalibur workflows list\` to see the catalog.`,
        );
      }

      // The intent-driven run prompt (onboarding §6).
      for (;;) {
        deps.ui.write();
        deps.ui.heading(`Using: ${choice.definition.name} (${choice.workflowId})`);
        deps.ui.write(`Autonomy: ${AUTONOMY_LEVEL_LABELS[choice.autonomyLevel]}`);
        deps.ui.write(safetyLine(config));
        deps.ui.info(`Reason: ${choice.reason}`);
        if (intent.sensitive) {
          deps.ui.warn(`Sensitive areas: ${intent.sensitiveAreas.join(', ')}`);
        }
        printPlanPreview(deps, choice.definition);

        const answer = await deps.ui.ask('[Enter] continue  [m] change mode  [c] cancel', {
          yes,
          defaultAnswer: '',
        });
        const normalized = answer.trim().toLowerCase();
        if (normalized === 'c' || normalized === 'cancel') {
          deps.ui.info('Run cancelled.');
          return;
        }
        if (normalized === 'm') {
          const styles: ExecutionStyle[] = ['fast', 'careful', 'structured', 'explore', 'team_default'];
          const index = await deps.ui.select(
            'Execution mode:',
            [
              { label: 'Fast', hint: 'small fixes, minimal ceremony' },
              { label: 'Careful', hint: 'Level 4, stronger approvals' },
              { label: 'Structured', hint: 'spec → plan → implement → verify' },
              { label: 'Explore', hint: 'compare engineering alternatives' },
              { label: 'Team default' },
            ],
            { defaultIndex: 4 },
          );
          const style = styles[index] ?? 'team_default';
          choice = choose(style === 'team_default' ? undefined : style, explicitLevel);
          continue;
        }
        break;
      }

      const effective = await buildEffectiveContext(deps, repoRoot, {
        workflowId: choice.workflowId,
        autonomyLevel: choice.autonomyLevel,
      });
      for (const warning of effective.warnings) {
        deps.ui.warn(warning);
      }

      const gatewayContext = loadGatewayContext(repoRoot);
      const methodology =
        registry.contributions.methodologies().find((entry) => entry.id === choice.workflowId)?.id ??
        null;

      const runManager = new RunManager(repoRoot);
      const run = runManager.createRun({
        title: task,
        autonomyLevel: choice.autonomyLevel,
        workflow: choice.workflowId,
        methodology,
        model: gatewayContext.providerName,
        executionStyle: choice.executionStyle,
      });
      deps.ui.write();
      deps.ui.info(`Run ${run.id} → ${run.dir}`);

      const interactive = deps.ui.isInteractive() && !yes;
      const record = await executeLocalRun({
        repoRoot,
        runManager,
        run,
        definition: choice.definition,
        gateway: gatewayContext.gateway,
        adapter: new NativeAgentAdapter(),
        config,
        // Without a confirm fn the engine auto-approves ({ auto: true }) —
        // exactly what --yes / non-interactive runs want.
        ...(interactive
          ? {
              confirm: (question: string): Promise<boolean> =>
                deps.ui.confirm(question, { defaultYes: true }),
            }
          : {}),
        onEvent: (event): void => {
          const line = describeEvent(event);
          if (line !== null) {
            deps.ui.write(line);
          }
        },
      });

      deps.ui.write();
      if (record.status === 'completed') {
        deps.ui.success(`Run ${run.id} completed.`);
      } else {
        deps.ui.warn(`Run ${run.id} finished with status: ${record.status}`);
      }
      deps.ui.info(`Artifacts: ${run.dir}`);
      deps.ui.info(`Inspect with: excalibur logs ${run.id}`);

      if (options.sync === true) {
        await pushLatestRun(deps, run.id);
      }
    });
}
