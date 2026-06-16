import { NativeAgentAdapter } from '@excalibur/agent-runtime';
import {
  RunManager,
  classifyTaskIntent,
  createExtensionHost,
  executeLocalRun,
  planAgentAllocation,
  selectWorkflow,
  workflowCatalog,
  type TaskIntent,
} from '@excalibur/core';
import { analyzeRepository } from '@excalibur/context-engine';
import {
  AUTONOMY_LEVEL_LABELS,
  type AutonomyLevel,
  type ExcaliburEvent,
  type ExecutionStyle,
  type RunRecord,
} from '@excalibur/shared';
import type { WorkflowDefinition } from '@excalibur/workflow-schema';
import pc from 'picocolors';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import {
  buildEffectiveContext,
  loadConfigContext,
  loadGatewayContext,
  requireConfiguredModel,
  safetyLine,
} from './context';
import { runDiscoveryFlow } from '../commands/discovery';
import { pushLatestRun } from '../commands/login';

/** Resolved options for {@link runTask} (flag parsing lives in the command). */
export interface RunTaskOptions {
  level?: AutonomyLevel;
  style?: ExecutionStyle;
  workflow?: string;
  /** Power-user override of the auto-sized agent count (`--agents`). */
  agents?: number;
  /** Hard ceiling on the agent count (`--max-agents`). */
  maxAgents?: number;
  yes?: boolean;
  sync?: boolean;
}

/** Distinct path-like mentions in a task — a rough pre-plan "affected modules" proxy. */
const TASK_PATH_PATTERN = /[\w.-]+(?:\/[\w.-]+)+/g;
function estimateAffectedUnits(task: string): number {
  const mentions = new Set(task.match(TASK_PATH_PATTERN) ?? []);
  return Math.max(1, mentions.size);
}

interface RunChoice {
  autonomyLevel: AutonomyLevel;
  executionStyle: ExecutionStyle;
  workflowId: string;
  definition: WorkflowDefinition;
  reason: string;
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
      // Derive "(simulated)" from the payload — the real native loop writes for
      // real (no flag); only the M1 phase engine sets simulated:true. Hardcoding
      // it lied about real writes.
      return pc.dim(`  write ${str('path')}${payload['simulated'] === true ? ' (simulated)' : ''}`);
    case 'command_started':
      return pc.dim(`  $ ${str('command')}${payload['simulated'] === true ? ' (simulated)' : ''}`);
    case 'command_completed': {
      // Surface the result (previously dropped → the user never saw exit codes).
      const exit = typeof payload['exitCode'] === 'number' ? (payload['exitCode'] as number) : null;
      if (exit === null) {
        return null;
      }
      const tail = payload['simulated'] === true ? ' (simulated)' : '';
      return exit === 0
        ? pc.dim(`  ⎿ exit 0${tail}`)
        : pc.red(`  ⎿ exit ${exit}${tail}`);
    }
    case 'test_result':
      return pc.green(`  tests: ${str('status') || 'passed'}${payload['simulated'] === true ? ' (simulated)' : ''}`);
    case 'patch_generated':
      return pc.yellow('  ± patch generated');
    case 'patch_applied':
      return pc.yellow(`  ± patch applied${payload['simulated'] === true ? ' (simulated)' : ''}`);
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
 * `excalibur run "<task>"` orchestration (Build Contract §4.9), extracted from
 * the Commander action so it can be reused by the interactive M-Shell REPL.
 * classifyTaskIntent decides the workflow, the prompt shows the choice with
 * `[Enter] continue [m] change mode [c] cancel`, every run prints the active
 * safety preset, then selectWorkflow → RunManager → executeLocalRun with the
 * NativeAgentAdapter + MockProvider, streaming events to the terminal.
 *
 * Returns the finished {@link RunRecord}, or `null` when the user cancels at
 * the run prompt or is diverted to Discovery (no run is created).
 */
export async function runTask(
  deps: CliDeps,
  task: string,
  options: RunTaskOptions = {},
): Promise<RunRecord | null> {
  const repoRoot = deps.cwd();
  const yes = options.yes === true;

  const explicitLevel = options.level;
  const explicitStyle = options.style;

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
      return null;
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

    // Swarm sizing (pre-plan estimate). The developer never picks the count;
    // the allocator does, explainably. Shown only when it sizes to >1 — and
    // honestly: the parallel fan-out itself executes in a later milestone, so
    // this run still uses a single agent.
    const allocation = planAgentAllocation({
      taskType: intent.taskType,
      sensitive: intent.sensitive,
      affectedUnits: estimateAffectedUnits(task),
      ...(options.agents !== undefined ? { requested: options.agents } : {}),
      ...(options.maxAgents !== undefined ? { maxAgents: options.maxAgents } : {}),
    });
    if (allocation.agentCount > 1) {
      deps.ui.write(pc.dim(`Swarm: ${allocation.reason}`));
      deps.ui.write(pc.dim('  (parallel fan-out is coming; this run uses one agent for now)'));
    }
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
      return null;
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
  requireConfiguredModel(gatewayContext); // no mock fallback: a real LLM is required
  // Resolve the methodology deliberately, not by id collision (§4.6 treats
  // methodology as an independent input). Each methodology declares the
  // workflow it drives via `defaultWorkflow`, which is the correct linkage
  // (e.g. spec-driven → structured-feature, review-first → review-only).
  // Prefer that reverse lookup, fall back to a same-id match (covers the
  // ids that coincide, e.g. fast-fix), then null.
  const methodologies = registry.contributions.methodologies();
  const methodology =
    methodologies.find((entry) => entry.defaultWorkflow === choice.workflowId)?.id ??
    methodologies.find((entry) => entry.id === choice.workflowId)?.id ??
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
  return record;
}
