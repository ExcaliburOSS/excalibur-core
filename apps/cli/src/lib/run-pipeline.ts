import { NativeAgentAdapter } from '@excalibur/agent-runtime';
import {
  RunManager,
  classifyTaskIntent,
  createExtensionHost,
  executeLocalRun,
  planAgentAllocation,
  selectWorkflow,
  workflowCatalog,
  type AdditionalContextSource,
  type TaskIntent,
} from '@excalibur/core';
import { analyzeRepository } from '@excalibur/context-engine';
import {
  AUTONOMY_LEVEL_LABELS,
  type AutonomyLevel,
  type ExcaliburEvent,
  type ExecutionStyle,
  type RunRecord,
  type Translator,
} from '@excalibur/shared';
import type { WorkflowDefinition } from '@excalibur/workflow-schema';
import {
  detectColorTier,
  detectThemeSync,
  paletteFor,
  reduceRail,
  renderPlanCard,
  renderRail,
} from '@excalibur/tui';
import { LiveRail } from './live-rail';
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
import { diagnosticsContextSource, runDiagnostics } from './diagnostics';
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
  /**
   * Run the repo typecheck first and feed its REAL compiler errors into the
   * agent's context (M3 LSP-diagnostics value; opt-in — typecheck can be slow).
   */
  diagnostics?: boolean;
  /** Hard per-run budget ceiling in US dollars (`--budget`); overrides config. */
  budgetUsd?: number;
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

/** Compact terminal line for one streamed run event (non-TTY/CI fallback). */
export function describeEvent(t: Translator, event: ExcaliburEvent): string | null {
  const payload = event.payload;
  const str = (key: string): string => {
    const value = payload[key];
    return typeof value === 'string' ? value : '';
  };
  // "(simulated)" is the M1 phase-engine marker; the real native loop omits it.
  const sim = payload['simulated'] === true ? t('event.simulated') : '';
  switch (event.type) {
    case 'run_started':
      return pc.bold(t('event.run-started'));
    case 'workflow_selected':
      return pc.dim(t('event.workflow', { workflow: str('workflow') || str('workflowId') }));
    case 'methodology_selected':
      return pc.dim(t('event.methodology', { methodology: str('methodology') || str('methodologyId') }));
    case 'phase_started':
      return pc.cyan(t('event.phase-started', { name: str('name') || str('phaseId') || event.phaseId || 'phase' }));
    case 'phase_completed':
      return pc.green(t('event.phase-completed', { name: str('name') || str('phaseId') || event.phaseId || 'phase' }));
    case 'assistant_message':
      return pc.dim(t('event.assistant-message'));
    case 'model_call':
      return pc.dim(t('event.model-call', { model: str('model') || 'mock' }));
    case 'tool_call':
      return pc.dim(t('event.tool-call', { tool: str('tool') || str('name') }));
    case 'file_read':
      return pc.dim(t('event.file-read', { path: str('path') }));
    case 'file_write':
      return pc.dim(t('event.file-write', { path: str('path'), sim }));
    case 'command_started':
      return pc.dim(t('event.command-started', { command: str('command'), sim }));
    case 'command_completed': {
      const exit = typeof payload['exitCode'] === 'number' ? (payload['exitCode'] as number) : null;
      if (exit === null) {
        return null;
      }
      return exit === 0
        ? pc.dim(t('event.exit-ok', { sim }))
        : pc.red(t('event.exit-fail', { exit, sim }));
    }
    case 'test_result':
      return pc.green(t('event.test-result', { status: str('status') || 'passed', sim }));
    case 'patch_generated':
      return pc.yellow(t('event.patch-generated'));
    case 'patch_applied':
      return pc.yellow(t('event.patch-applied', { sim }));
    case 'branch_created':
      return pc.yellow(t('event.branch-created', { branch: str('branch') }));
    case 'approval_requested':
      return pc.yellow(t('event.approval-requested'));
    case 'approval_approved':
      return pc.green(t('event.approval-approved'));
    case 'approval_rejected':
      return pc.red(t('event.approval-rejected'));
    case 'artifact_created':
      return pc.dim(t('event.artifact-created', { name: str('fileName') || str('path') }));
    case 'error':
      return pc.red(t('event.error', { message: str('message') }));
    case 'verification':
      return payload['blocked'] === true
        ? pc.red(t('event.verification-blocked', { summary: str('summary') }))
        : pc.green(t('event.verification-passed', { summary: str('summary') }));
    case 'claim': {
      const status = str('status');
      const text = t('event.claim', { statement: str('statement'), status });
      return status === 'refuted' ? pc.red(text) : status === 'verified' ? pc.green(text) : pc.dim(text);
    }
    case 'run_completed':
      return pc.bold(t('event.run-completed', { status: str('status') || 'completed' }));
    default:
      return pc.dim(t('event.unknown', { type: event.type }));
  }
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
    const runDiscovery = await deps.ui.confirm(deps.t('run-pipeline.discoveryPrompt'), {
      yes,
      defaultYes: !yes,
    });
    if (runDiscovery) {
      await runDiscoveryFlow(deps, { input: task, inputType: 'idea', yes });
      return null;
    }
    deps.ui.info(deps.t('run-pipeline.continuingWithoutDiscovery'));
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
      deps.t('run-pipeline.unknownWorkflow', { workflow: options.workflow }),
    );
  }

  const tier = detectColorTier();
  const mode = detectThemeSync() ?? 'dark';
  // Honour the configured theme preset (ui.theme: auto/dark/light/daltonized/…)
  // across the WHOLE live rail, not just the diff view.
  const palette = paletteFor(config.ui?.theme ?? 'auto', mode);

  // The intent-driven run prompt (onboarding §6).
  for (;;) {
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

    // The PLAN card: one bordered, gated node in the rail's visual language
    // (vs CC's markdown lost in scrollback). Workflow + autonomy header, a
    // pending node per phase, swarm sizing + sensitive areas when present.
    deps.ui.write();
    const planCard = renderPlanCard(
      {
        workflowName: choice.definition.name,
        workflowId: choice.workflowId,
        autonomyLabel: AUTONOMY_LEVEL_LABELS[choice.autonomyLevel],
        phases: choice.definition.phases.map((phase) => ({
          name: phase.name,
          type: phase.type,
          optional: phase.required === false,
        })),
        ...(allocation.agentCount > 1
          ? { swarmReason: `${allocation.reason} (fan-out lands in a later milestone)` }
          : {}),
        ...(intent.sensitive ? { sensitiveAreas: intent.sensitiveAreas } : {}),
        gate: deps.t('run-pipeline.gate'),
      },
      { tier, mode },
    );
    for (const line of planCard) {
      deps.ui.write(line);
    }
    deps.ui.write(safetyLine(deps.t, config));
    deps.ui.info(deps.t('run-pipeline.reason', { reason: choice.reason }));

    const answer = await deps.ui.ask(deps.t('run-pipeline.runPromptGate'), {
      yes,
      defaultAnswer: '',
    });
    const normalized = answer.trim().toLowerCase();
    if (normalized === 'c' || normalized === 'cancel') {
      deps.ui.info(deps.t('run-pipeline.runCancelled'));
      return null;
    }
    if (normalized === 'm') {
      const styles: ExecutionStyle[] = ['fast', 'careful', 'structured', 'explore', 'team_default'];
      const index = await deps.ui.select(
        deps.t('run-pipeline.executionModePrompt'),
        [
          { label: deps.t('run-pipeline.modeFastLabel'), hint: deps.t('run-pipeline.modeFastHint') },
          { label: deps.t('run-pipeline.modeCarefulLabel'), hint: deps.t('run-pipeline.modeCarefulHint') },
          { label: deps.t('run-pipeline.modeStructuredLabel'), hint: deps.t('run-pipeline.modeStructuredHint') },
          { label: deps.t('run-pipeline.modeExploreLabel'), hint: deps.t('run-pipeline.modeExploreHint') },
          { label: deps.t('run-pipeline.modeTeamDefaultLabel') },
        ],
        { defaultIndex: 4 },
      );
      const style = styles[index] ?? 'team_default';
      choice = choose(style === 'team_default' ? undefined : style, explicitLevel);
      continue;
    }
    break;
  }

  // Real compiler diagnostics (M3): with --diagnostics, run the repo typecheck
  // and feed its REAL errors into the agent's effective context, so fixes anchor
  // on the compiler — not hallucinated problems. Opt-in (typecheck can be slow).
  const diagnosticSources: AdditionalContextSource[] = [];
  if (options.diagnostics === true) {
    const typecheck = config.commands?.typecheck;
    if (typecheck === undefined) {
      deps.ui.warn(deps.t('review.noTypecheck'));
    } else {
      deps.ui.info(deps.t('review.runningDiagnostics', { typecheck }));
      const result = runDiagnostics(repoRoot, typecheck);
      const source = diagnosticsContextSource(result);
      if (source !== null) {
        diagnosticSources.push(source);
        deps.ui.warn(deps.t('review.typecheckErrors', { count: result.diagnostics.length || 'some' }));
      } else if (result.ok === true) {
        deps.ui.success(deps.t('review.typecheckClean'));
      }
    }
  }

  const effective = await buildEffectiveContext(deps, repoRoot, {
    workflowId: choice.workflowId,
    autonomyLevel: choice.autonomyLevel,
    ...(diagnosticSources.length > 0 ? { additionalSources: diagnosticSources } : {}),
  });
  for (const warning of effective.warnings) {
    deps.ui.warn(warning);
  }

  const gatewayContext = loadGatewayContext(repoRoot);
  requireConfiguredModel(gatewayContext, deps.t); // no mock fallback: a real LLM is required
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
  deps.ui.info(deps.t('run-pipeline.runDir', { id: run.id, dir: run.dir }));

  const interactive = deps.ui.isInteractive() && !yes;

  // The LIVING RAIL. On a TTY we redraw the whole rail block in place as events
  // stream (the rail fills with green as phases complete); on a piped/CI stdout
  // we stream plain per-event lines and print a static rail recap afterwards.
  // Both fold the SAME `reduceRail`, so live = scrub = replay.
  const reduceOpts = {
    autonomyLabel: AUTONOMY_LEVEL_LABELS[choice.autonomyLevel],
    safety: config.safety?.preset ?? 'standard-safe',
    model: gatewayContext.providerName,
    push: options.sync === true,
  };
  const railLabels = {
    push: deps.t('rail.push'),
    noPush: deps.t('rail.noPush'),
    tasks: deps.t('rail.tasks'),
  };
  const liveRail = deps.ui.isOutputTty()
    ? new LiveRail(
        { writeRaw: (t) => deps.ui.writeRaw(t) },
        { tier, mode, palette, reduce: reduceOpts, labels: railLabels },
      )
    : null;

  deps.ui.write();
  liveRail?.start();

  const confirm = (question: string): Promise<boolean> => {
    // Suspend the in-place redraw so the prompt prints below the rail cleanly,
    // then resume a fresh frame under the answer.
    liveRail?.pause();
    return deps.ui.confirm(question, { defaultYes: true }).finally(() => liveRail?.resume());
  };

  const record = await executeLocalRun({
    repoRoot,
    runManager,
    run,
    definition: choice.definition,
    gateway: gatewayContext.gateway,
    adapter: new NativeAgentAdapter(),
    config,
    // Hard budget cap: a `--budget` flag (USD→cents) overrides config.budget.maxRunUsd.
    ...(options.budgetUsd !== undefined ? { budgetCents: Math.round(options.budgetUsd * 100) } : {}),
    // Without a confirm fn the engine auto-approves ({ auto: true }) —
    // exactly what --yes / non-interactive runs want.
    ...(interactive ? { confirm } : {}),
    onEvent: (event): void => {
      if (liveRail !== null) {
        liveRail.push(event);
        return;
      }
      const line = describeEvent(deps.t, event);
      if (line !== null) {
        deps.ui.write(line);
      }
    },
  });

  if (liveRail !== null) {
    liveRail.stop();
  } else {
    // Non-TTY recap: a static rail of the recorded stream (byte-faithful to what
    // the TTY redraw settled on).
    deps.ui.write();
    for (const line of renderRail(reduceRail(runManager.readEvents(run.id), reduceOpts), {
      tier,
      mode,
      labels: railLabels,
    })) {
      deps.ui.write(line);
    }
  }

  deps.ui.write();
  if (record.status === 'completed') {
    deps.ui.success(deps.t('run-pipeline.runCompleted', { id: run.id }));
  } else {
    deps.ui.warn(deps.t('run-pipeline.runFinishedStatus', { id: run.id, status: record.status }));
  }
  deps.ui.info(deps.t('run-pipeline.artifacts', { dir: run.dir }));
  deps.ui.info(deps.t('run-pipeline.inspectWith', { id: run.id }));

  if (options.sync === true) {
    await pushLatestRun(deps, run.id);
  }
  return record;
}
