import { NativeAgentAdapter } from '@excalibur/agent-runtime';
import { activateExtensions } from '@excalibur-oss/extension-sdk';
import { LocalWorkItemProvider } from '@excalibur/work-items';
import {
  RunManager,
  classifyTaskIntent,
  createExtensionHost,
  extensionPolicyFromConfig,
  estimateRun,
  executeLocalRun,
  planAgentAllocation,
  resolveCustomAgent,
  selectWorkflow,
  workflowCatalog,
  type AdditionalContextSource,
  type CustomAgent,
  type RunEstimate,
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
import { type WorkflowDefinition } from '@excalibur/workflow-schema';
import {
  applyCustomColors,
  detectColorTier,
  detectThemeSync,
  paletteFor,
  reduceRail,
  renderPlanCard,
  renderRail,
} from '@excalibur/tui';
import { loadInkUi } from '../ink/load';
import type { RunViewHandle } from '@excalibur/tui/ink';
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
import { buildManagementToolset } from './management-tools';
import { warnDirtyTree } from './run-safety';
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
  /** Links the run to a work item (e.g. `work-items run` — the work-item-centric cycle). */
  workItemId?: string;
  /** Create a local work item from the task and link the run to it (planning-first). */
  createWorkItem?: boolean;
  /**
   * Name of a self-contained custom agent (P1.7) to run with — a
   * `.excalibur/agents/<name>.md` file. Its persona, model, sampling and
   * guardrails are applied to every `agent_work` phase. Unknown name → error.
   */
  agent?: string;
  /** Internal: this IS the diagnostics-repair run — do not trigger another (recursion guard). */
  internalRepair?: boolean;
  /**
   * Conversational mode (RUN-FIX-10): the interactive m-shell drives the SAME
   * gated workflow engine as `excalibur run`, but slims the chrome to the
   * conversational rail (compact status footer, the "⋯ N earlier" tail label) and
   * skips the one-shot CLI onboarding prompts (the dirty-tree nudge and the
   * discovery offer) that would be noise mid-conversation. So a build typed in the
   * shell gets the complexity-sized workflow + Verify/Review + mesh + claims, with
   * the friendly interface — never a degraded single loop.
   */
  conversational?: boolean;
  /**
   * Abort signal (the shell's per-turn ESC controller). Forwarded to the engine
   * so cancelling the turn ends the run at the next phase boundary and kills any
   * in-flight tool; also aborted by the rail's own ESC.
   */
  signal?: AbortSignal;
  /**
   * Typing-during-execution (INT-1, RUN-FIX-16): the live rail's interrupt channel.
   * A message the user types WHILE the build streams is handed here with a control
   * over the run (abort + acknowledge), so the shell's interrupt brain can triage it
   * — steer → queue for right after the run, independent → parallel `/bg`, quick → an
   * inline answer, stop → abort — WITHOUT losing the running work. Wired only on the
   * Ink (TTY) path. Same shape as the conversational turn's `onInterrupt`, so the
   * shell hands its ONE handler to both surfaces.
   */
  onInterrupt?: (
    text: string,
    control: {
      currentWork: string;
      awaitingAnswer: boolean;
      pendingQuestion?: string;
      touchedPaths: string[];
      abort(): void;
      say(text: string): void;
    },
  ) => void | Promise<void>;
  /**
   * A CALLER-OWNED rail to render into (RUN-FIX-23). When set, runTask renders into THIS
   * view instead of mounting its own — it clears the prior run's events (`resetEvents`) at
   * the start but does NOT suspend stdin, mount, wire ESC/interrupt, finish or unmount; the
   * caller owns that lifecycle. This is how a conversational build keeps ONE persistent
   * input box (InterruptBox) across the decompose + build + every self-heal run, instead of
   * mounting/unmounting per run (which made the input box flicker away between runs — the
   * "el input desaparece durante la ejecución" bug). resetEvents PRESERVES interruptEnabled
   * + the draft, so the input the user is typing survives the reset.
   */
  view?: RunViewHandle;
}

/** Maps a resolved custom agent onto the engine's agent-override shape. */
function agentOverrides(
  agent: CustomAgent,
): NonNullable<Parameters<typeof executeLocalRun>[0]['agent']> {
  return {
    systemPrompt: agent.systemPrompt,
    ...(agent.role !== undefined ? { role: agent.role } : {}),
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    ...(agent.provider !== undefined ? { provider: agent.provider } : {}),
    ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
    ...(agent.tools !== undefined ? { allowedTools: agent.tools } : {}),
    ...(agent.permissions !== undefined ? { permissions: agent.permissions } : {}),
  };
}

/** Formats a {@link RunEstimate} as the plan card's one-line forecast. */
function formatEstimate(deps: CliDeps, est: RunEstimate): string {
  const cost = `~$${(est.estCostCents / 100).toFixed(2)}`;
  const secs = Math.round(est.estDurationMs / 1000);
  const eta =
    secs < 60 ? `~${secs}s` : `~${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s`;
  const files = deps.t('run-pipeline.estimateFiles', { count: est.blastRadius });
  const basis =
    est.basedOnRuns > 0
      ? deps.t('run-pipeline.estimateFromRuns', { count: est.basedOnRuns })
      : deps.t('run-pipeline.estimateHeuristic');
  return `${cost} · ${eta} · ${files} ${basis}`;
}

/** Distinct path-like mentions in a task — a rough pre-plan "affected modules" proxy. */
const TASK_PATH_PATTERN = /[\w.-]+(?:\/[\w.-]+)+/g;

/**
 * Frames to wait between `view.finish()` and `unmount()` (RUN-FIX-22 part 2) so React +
 * Ink flush the no-live-chrome frame before the rail tears down. ~2 frames is plenty and
 * imperceptible; it only runs once per run at teardown.
 */
const RAIL_FINALIZE_MS = 64;
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
      return pc.dim(
        t('event.methodology', { methodology: str('methodology') || str('methodologyId') }),
      );
    case 'phase_started':
      return pc.cyan(
        t('event.phase-started', {
          name: str('name') || str('phaseId') || event.phaseId || 'phase',
        }),
      );
    case 'phase_completed':
      return pc.green(
        t('event.phase-completed', {
          name: str('name') || str('phaseId') || event.phaseId || 'phase',
        }),
      );
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
    case 'test_result': {
      // Color by the ACTUAL status — a failed test must not render green.
      const status = str('status') || 'passed';
      const text = t('event.test-result', { status, sim });
      const passed = status === 'passed' || status === 'green' || status === 'ok';
      return passed ? pc.green(text) : pc.red(text);
    }
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
      return status === 'refuted'
        ? pc.red(text)
        : status === 'verified'
          ? pc.green(text)
          : pc.dim(text);
    }
    case 'policy_decision': {
      const decision = str('decision') || 'decision';
      const message = str('message');
      const text = t('event.policy-decision', {
        decision,
        message: message.length > 0 ? ` — ${message}` : '',
      });
      return decision === 'deny'
        ? pc.red(text)
        : decision === 'ask'
          ? pc.yellow(text)
          : pc.dim(text);
    }
    case 'task_update': {
      const tasks = Array.isArray(payload['tasks']) ? (payload['tasks'] as unknown[]) : [];
      const done = tasks.filter(
        (item) => (item as { status?: unknown } | null)?.status === 'completed',
      ).length;
      return pc.dim(t('event.task-update', { done, total: tasks.length }));
    }
    case 'compaction': {
      const num = (key: string): number =>
        typeof payload[key] === 'number' ? (payload[key] as number) : 0;
      return pc.dim(
        t('event.compaction', { before: num('tokensBefore'), after: num('tokensAfter') }),
      );
    }
    case 'diagnostics': {
      const num = (key: string): number =>
        typeof payload[key] === 'number' ? (payload[key] as number) : 0;
      const errors = num('errorCount');
      const warnings = num('warningCount');
      if (errors === 0 && warnings === 0) {
        return null; // a clean file — don't add noise to the log
      }
      const text = t('event.diagnostics', { file: str('file'), errors, warnings });
      return errors > 0 ? pc.red(text) : pc.yellow(text);
    }
    case 'run_completed':
      return pc.bold(t('event.run-completed', { status: str('status') || 'completed' }));
    default:
      return pc.dim(t('event.unknown', { type: event.type }));
  }
}

/** A caller-owned conversational rail kept up across a whole multi-run turn (RUN-FIX-23). */
export interface ConversationalRail {
  /** The live rail to inject into every {@link runTask} of the turn (via `options.view`). */
  view: RunViewHandle;
  /**
   * Surface a one-line banner (e.g. a self-heal notice) INSIDE the rail. The caller MUST
   * route every between-run message through this — a direct `deps.ui.*` write to stdout
   * while the Ink rail owns the screen corrupts the live frame (the old "se duplica el
   * input/footer" class of bug).
   */
  notice(text: string): void;
  /** Finish + unmount the rail and hand stdin back to the editor. Idempotent. */
  close(): Promise<void>;
}

/**
 * Mount ONE persistent conversational rail (RUN-FIX-23) that a whole multi-run turn — the
 * build PLUS every self-heal pass — renders into, so the input box (InterruptBox) stays put
 * the entire time instead of flickering away each time a sub-run mounts/unmounts its own
 * rail ("el input desaparece durante la ejecución / durante la evaluación"). The caller
 * passes the returned `view` to every {@link runTask} via `options.view`; each run clears
 * the prior run's events (`resetEvents`, which PRESERVES `interruptEnabled` + the typed
 * draft so the input survives), draws fresh, but the rail — and the input box armed here —
 * lives across all of them. The caller closes it ONCE, before printing the warm receipt.
 *
 * Returns `null` off a TTY (no live rail; the runs stream plain lines and there is no input
 * box to keep) — the caller then just runs each task normally.
 */
export async function mountConversationalRail(
  deps: CliDeps,
  opts: {
    currentWork: string;
    autonomyLevel: AutonomyLevel;
    onAbort: () => void;
    onInterrupt?: RunTaskOptions['onInterrupt'];
  },
): Promise<ConversationalRail | null> {
  if (!deps.ui.isOutputTty()) {
    return null;
  }
  const repoRoot = deps.cwd();
  const { config } = loadConfigContext(repoRoot);
  const gatewayContext = loadGatewayContext(repoRoot);
  const tier = detectColorTier();
  const mode = detectThemeSync() ?? 'dark';
  const palette = applyCustomColors(
    paletteFor(config.ui?.theme ?? 'auto', mode),
    config.ui?.customTheme,
  );
  const reduceOpts = {
    autonomyLabel: AUTONOMY_LEVEL_LABELS[opts.autonomyLevel],
    safety: config.safety?.preset ?? 'standard-safe',
    model: gatewayContext.providerName,
    push: false,
  };
  const railLabels = {
    push: deps.t('rail.push'),
    noPush: deps.t('rail.noPush'),
    tasks: deps.t('rail.tasks'),
    earlier: deps.t('rail.earlier'),
    interruptHint: deps.t('rail.interrupt-hint'),
  };
  // The rail OWNS stdin for the whole turn: suspend the caller's raw editor ONCE (paired
  // with resumeInput() in close()). Without this the REPL editor and Ink's useInput both
  // read the same keystrokes. Mounting is the only risky step — if it ever throws, RESUME
  // stdin and degrade to null (plain-line runs) rather than crash or leave stdin dead.
  deps.ui.suspendInput();
  let view: RunViewHandle;
  try {
    const ink = await loadInkUi();
    view = ink.mountRunView({
      palette,
      tier,
      mode,
      reduce: reduceOpts,
      labels: railLabels,
      compactStatus: true,
    });
  } catch {
    try {
      deps.ui.resumeInput();
    } catch {
      /* best-effort */
    }
    return null;
  }
  // ESC anywhere in the turn aborts the whole turn (the editor is suspended, so route it
  // here). Each runTask also gets the turn's signal, so its in-flight run aborts too.
  view.onEscape(() => opts.onAbort());
  // Typing-during-execution (RUN-FIX-16): arming onInterrupt also turns the input box ON
  // (interruptEnabled), which is the whole point — the box is now PERMANENT across the turn.
  if (opts.onInterrupt !== undefined) {
    const handler = opts.onInterrupt;
    view.onInterrupt((text) => {
      void Promise.resolve(
        handler(text, {
          currentWork: opts.currentWork,
          awaitingAnswer: false,
          touchedPaths: [],
          abort: () => opts.onAbort(),
          say: (s) => view.noticeInterrupt(s),
        }),
      ).catch(() => {
        /* triage is best-effort — a handler error never breaks the turn */
      });
    });
  }
  let closed = false;
  return {
    view,
    notice: (text: string): void => {
      try {
        view.noticeInterrupt(text);
      } catch {
        /* a rail notice is best-effort — never break the turn */
      }
    },
    close: async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        view.finish();
      } catch {
        /* best-effort */
      }
      await new Promise((resolve) => setTimeout(resolve, RAIL_FINALIZE_MS));
      try {
        view.unmount();
      } catch {
        /* a rail teardown fault must never propagate — nunca es nunca */
      }
      try {
        deps.ui.resumeInput();
      } catch {
        /* re-arming is best-effort; the next question() re-enables raw lazily */
      }
    },
  };
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
  // Conversational (m-shell, RUN-FIX-10): the shell already routed/decided, so the
  // one-shot CLI chrome — the plan-card gate, the run-dir line, the footer — is
  // skipped; the live rail + warm receipt speak instead.
  const conversational = options.conversational === true;

  // Self-contained custom agent (P1.7): resolve `--agent <name>` early so an
  // unknown name fails before any work, with a clear message.
  let customAgent: CustomAgent | null = null;
  if (options.agent !== undefined) {
    customAgent = resolveCustomAgent(options.agent, {
      repoRoot,
      homeDir: deps.homeDir(),
      includeGlobal: deps.includeUserGlobal,
    });
    if (customAgent === null) {
      throw new CliUsageError(
        `unknown agent "${options.agent}". Add .excalibur/agents/${options.agent}.md ` +
          `(or run \`excalibur agents list\` to see what's available).`,
      );
    }
  }

  const explicitLevel = options.level;
  const explicitStyle = options.style;

  const { config } = loadConfigContext(repoRoot);
  const analysis = await analyzeRepository(repoRoot, {
    homeDir: deps.homeDir(),
    includeUserGlobal: deps.includeUserGlobal,
  });
  const intent: TaskIntent = classifyTaskIntent(task, analysis, config);

  // Enforce the project's extension policy (P2.18): a blocked extension's code
  // never runs in the agent loop.
  const registry = await createExtensionHost(repoRoot, extensionPolicyFromConfig(config));
  const catalog = workflowCatalog(registry);

  // Activate loaded extensions and harvest the agent tools they contribute, so
  // the native loop advertises + executes them (extensions-spec.md §5). A
  // failing extension is reported, never fatal.
  // The SDK ships self-contained, so its `.d.ts` carries its OWN inlined copy of
  // `ExtensionRegistry` — structurally identical to the one `createExtensionHost`
  // returns, but a distinct declaration, so TS needs the bridge. Same runtime
  // object; the SDK's `activateExtensions` was built to operate on exactly it.
  const activation = await activateExtensions(
    registry as unknown as Parameters<typeof activateExtensions>[0],
  );
  for (const warning of activation.warnings) {
    deps.ui.warn(warning);
  }
  const extensionTools = activation.tools;

  // Ambiguous tasks: recommend Discovery first (onboarding §6) unless the
  // user pinned a workflow/level explicitly. When declined, the run
  // continues with the standard defaults (not the discovery workflow).
  let useIntentDefaults = true;
  if (
    intent.recommendDiscoveryFirst &&
    options.conversational !== true && // the shell already routed/decided — no onboarding offer
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

  const choose = (
    style: ExecutionStyle | undefined,
    level: AutonomyLevel | undefined,
  ): RunChoice => {
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
    throw new CliUsageError(deps.t('run-pipeline.unknownWorkflow', { workflow: options.workflow }));
  }

  const tier = detectColorTier();
  const mode = detectThemeSync() ?? 'dark';
  // Honour the configured theme preset (ui.theme: auto/dark/light/daltonized/…)
  // across the WHOLE live rail, not just the diff view.
  const palette = applyCustomColors(
    paletteFor(config.ui?.theme ?? 'auto', mode),
    config.ui?.customTheme,
  );

  // The intent-driven run prompt (onboarding §6). Skipped in the conversational
  // m-shell: the shell already routed/decided the build, so the plan-card gate
  // would be run-tracker chrome the conversation must not speak — proceed with the
  // chosen workflow and let the live rail show the phases.
  for (; !conversational; ) {
    // Swarm sizing (pre-plan estimate). The developer never picks the count;
    // the allocator does, explainably. Shown only when it sizes to >1 — and
    // honestly: the parallel fan-out itself executes in a later milestone, so
    // this run still uses a single agent.
    const affectedUnits = estimateAffectedUnits(task);
    const allocation = planAgentAllocation({
      taskType: intent.taskType,
      sensitive: intent.sensitive,
      affectedUnits,
      ...(options.agents !== undefined ? { requested: options.agents } : {}),
      ...(options.maxAgents !== undefined ? { maxAgents: options.maxAgents } : {}),
    });

    // PRE-FLIGHT ESTIMATE (differentiator #2): forecast cost + ETA from the
    // repo's own run history (heuristic on a cold start) so the gate is informed,
    // not blind. With a budget cap, warn BEFORE spending a token if it won't fit.
    const estimate = estimateRun(repoRoot, {
      workflow: choice.workflowId,
      taskType: intent.taskType,
      affectedUnits,
    });
    const overBudget =
      options.budgetUsd !== undefined && estimate.estCostCents > options.budgetUsd * 100;

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
        estimate: formatEstimate(deps, estimate),
        ...(intent.sensitive ? { sensitiveAreas: intent.sensitiveAreas } : {}),
        gate: deps.t('run-pipeline.gate'),
      },
      { tier, mode },
    );
    for (const line of planCard) {
      deps.ui.write(line);
    }
    deps.ui.write(safetyLine(deps.t, config));
    if (overBudget) {
      deps.ui.warn(
        deps.t('run-pipeline.estimateOverBudget', {
          cost: `$${(estimate.estCostCents / 100).toFixed(2)}`,
          budget: `$${(options.budgetUsd as number).toFixed(2)}`,
        }),
      );
    }
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
          {
            label: deps.t('run-pipeline.modeFastLabel'),
            hint: deps.t('run-pipeline.modeFastHint'),
          },
          {
            label: deps.t('run-pipeline.modeCarefulLabel'),
            hint: deps.t('run-pipeline.modeCarefulHint'),
          },
          {
            label: deps.t('run-pipeline.modeStructuredLabel'),
            hint: deps.t('run-pipeline.modeStructuredHint'),
          },
          {
            label: deps.t('run-pipeline.modeExploreLabel'),
            hint: deps.t('run-pipeline.modeExploreHint'),
          },
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
        deps.ui.warn(
          deps.t('review.typecheckErrors', { count: result.diagnostics.length || 'some' }),
        );
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

  // Planning-first: link the run to a work item — either an explicit one
  // (`workItemId`) or a fresh local one created from the task (`createWorkItem`).
  // Ad-hoc runs omit both (they show in the dashboard's "Unassigned" lane).
  let workItemId = options.workItemId;
  if (workItemId === undefined && options.createWorkItem === true) {
    const wi = new LocalWorkItemProvider(repoRoot).createWorkItem({ title: task });
    workItemId = wi.key;
    deps.ui.info(`Created work item ${wi.key} for this task and linked the run to it.`);
  }

  const runManager = new RunManager(repoRoot);
  const run = runManager.createRun({
    title: task,
    autonomyLevel: choice.autonomyLevel,
    workflow: choice.workflowId,
    methodology,
    model: gatewayContext.providerName,
    executionStyle: choice.executionStyle,
    ...(workItemId !== undefined ? { workItemId } : {}),
  });
  // Only write to stdout when we are NOT rendering into a caller-owned rail. With an
  // injected `view` the Ink rail is already mounted and owns the screen — a stray blank
  // line here would corrupt the live frame (the input/footer-corruption class of bug).
  if (options.view === undefined) {
    deps.ui.write();
    if (!conversational) {
      // Run-tracker line ("Task run_X → <dir>") — CLI chrome the m-shell never speaks.
      deps.ui.info(deps.t('run-pipeline.runDir', { id: run.id, dir: run.dir }));
    }
  }

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
    // The "⋯ N earlier" collapse indicator for the live tail (RUN-FIX-2).
    earlier: deps.t('rail.earlier'),
    interruptHint: deps.t('rail.interrupt-hint'),
  };
  // An agentic run mutates the real tree — nudge to a clean, revertible start.
  // The conversational shell already lives in the repo; the nudge is one-shot-CLI
  // noise mid-conversation, so it is skipped there.
  if (!conversational) {
    warnDirtyTree(deps, repoRoot);
  }

  // ESC (the shell's per-turn controller) and the rail's own ESC both abort the
  // run; the merged signal is forwarded to the engine (ends at the next phase
  // boundary + kills in-flight tools).
  const runController = new AbortController();
  const onParentAbort = (): void => runController.abort();
  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      runController.abort();
    } else {
      options.signal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  // The live rail renders with Ink (<RunView>) on a TTY; a piped/CI stdout
  // streams plain per-event lines + a static renderRail recap. Both fold the
  // SAME reduceRail, so live = scrub = replay. The conversational shell slims the
  // footer to time · tokens · cost (drops the level/safety/push/model jargon).
  let inkHandle: RunViewHandle | null = null;
  // Whether THIS runTask owns the rail lifecycle (mount + teardown). FALSE when the caller
  // injected a `view` — then the caller (a conversational build keeping ONE persistent
  // input box across the build + every self-heal run) owns mount/stdin/handlers/teardown,
  // and we only render into it (RUN-FIX-23).
  const ownsView = options.view === undefined;
  if (options.view !== undefined) {
    // Reuse the caller-owned rail: clear the PRIOR run's events so this run draws a fresh
    // section, but KEEP the input box (resetEvents preserves interruptEnabled + the draft).
    // No suspendInput/mount and no ESC/interrupt wiring — the caller did that ONCE so the
    // input box never flickers away between runs.
    inkHandle = options.view;
    inkHandle.resetEvents();
  } else if (deps.ui.isOutputTty()) {
    // The Ink rail OWNS stdin for the run: suspend the caller's raw editor first so
    // the REPL editor and Ink's useInput don't both consume the same keystrokes
    // (a no-op for standalone `excalibur run`, which has no raw editor). Paired with
    // resumeInput() in the finally below.
    deps.ui.suspendInput();
    const ink = await loadInkUi();
    inkHandle = ink.mountRunView({
      palette,
      tier,
      mode,
      reduce: reduceOpts,
      labels: railLabels,
      ...(conversational ? { compactStatus: true } : {}),
    });
    inkHandle.onEscape(() => runController.abort());
    // Typing-during-execution (RUN-FIX-16): arm the rail's interrupt channel so the
    // user can TYPE while the build runs (the input stays live as a draft at the foot
    // of the rail). Each submitted message is handed to the shell's INT-1 brain with a
    // control over THIS run — it triages: a refinement is queued for right after the
    // run, an independent request spins off as a parallel `/bg`, a quick question is
    // answered inline, and "stop" aborts. Without this, keys are inert while a build
    // runs (the channel disarms when no handler is wired) — the bug being fixed.
    if (options.onInterrupt !== undefined) {
      const handler = options.onInterrupt;
      const view = inkHandle;
      view.onInterrupt((text) => {
        void Promise.resolve(
          handler(text, {
            currentWork: task,
            // A gated build captures its OWN approval keystrokes (y/n) while a gate is
            // open, so a typed draft is never an answer to a pending question here.
            awaitingAnswer: false,
            touchedPaths: [],
            abort: () => runController.abort(),
            say: (s) => view.noticeInterrupt(s),
          }),
        ).catch(() => {
          /* triage is best-effort — a handler error never breaks the run */
        });
      });
    }
  }

  // A blank line separates the run from what's above it — but ONLY for standalone
  // `excalibur run`. The m-shell build (conversational) already gets its single
  // user→reply blank at the REPL dispatch point, so emitting another here would
  // double it (RUN-FIX-15: one blank max).
  if (!conversational) {
    deps.ui.write();
  }

  const confirm = (question: string): Promise<boolean> => {
    if (inkHandle !== null) {
      // The approval renders inline in the Ink rail; y/Return/a → yes, n → no.
      return inkHandle
        .requestApproval({ question, options: '[Y/n]' })
        .then((answer) => answer !== 'no');
    }
    return deps.ui.confirm(question, { defaultYes: true });
  };

  // A const snapshot so the narration closure narrows cleanly (inkHandle is a let).
  const liveInk = inkHandle;
  let record: RunRecord;
  try {
    record = await executeLocalRun({
      repoRoot,
      runManager,
      run,
      signal: runController.signal,
      definition: choice.definition,
      gateway: gatewayContext.gateway,
      adapter: new NativeAgentAdapter(),
      config,
      // Extension-contributed tools harvested from activation, executed by the
      // native loop alongside the native tools. Omitted when no extension adds one.
      ...(extensionTools.length > 0 ? { extensionTools } : {}),
      // Proactive management tools: a gated build can pull project state (status /
      // work-items / sprints / plans / verify …) into its reasoning, same as a chat.
      management: buildManagementToolset(deps, repoRoot),
      // Custom agent (P1.7): persona, model, sampling and guardrails applied to
      // every agent_work phase. Omitted → the workflow's role + configured model.
      ...(customAgent !== null ? { agent: agentOverrides(customAgent) } : {}),
      // Hard budget cap: a `--budget` flag (USD→cents) overrides config.budget.maxRunUsd.
      ...(options.budgetUsd !== undefined
        ? { budgetCents: Math.round(options.budgetUsd * 100) }
        : {}),
      // Without a confirm fn the engine auto-approves ({ auto: true }) —
      // exactly what --yes / non-interactive runs want.
      ...(interactive ? { confirm } : {}),
      // Free-text human channel for the `question` tool (P1.8b). Only when a human
      // is at a plain prompt (not under the Ink rail, which owns stdin); otherwise
      // the tool gracefully tells the model to proceed autonomously.
      ...(interactive && inkHandle === null
        ? { ask: (question: string): Promise<string> => deps.ui.ask(question) }
        : {}),
      onEvent: (event): void => {
        if (inkHandle !== null) {
          inkHandle.push(event);
          return;
        }
        const line = describeEvent(deps.t, event);
        if (line !== null) {
          deps.ui.write(line);
        }
      },
      // Live narration: type the model's prose out as it streams, into the Ink rail
      // (only when the rail is up — a TTY). Piped/non-TTY runs stay non-streamed.
      ...(liveInk !== null
        ? {
            onNarration: ({ content }: { content: string }): void =>
              liveInk.streamNarration(content),
          }
        : {}),
    });
  } finally {
    // Always restore the terminal + stdin ownership, even on a throw: unmount the
    // rail (leaves the final frame in scrollback via <Static>) and resume the
    // caller's raw editor; drop the parent-signal listener so a finished run's
    // controller is not pinned alive.
    // ONLY tear down a rail we OWN. When the caller injected `view` (a conversational build
    // keeping ONE persistent input box across the build + every self-heal run), the caller
    // owns finish/unmount/resumeInput — tearing it down here would drop the input box
    // between runs (the "el input desaparece durante la ejecución" bug). We leave the rail
    // intact and visible for the next run / the caller's final close.
    if (inkHandle !== null && ownsView) {
      // FINISH then unmount (RUN-FIX-22 part 2): drop ALL live chrome (the InterruptBox +
      // StatusLine footer) and yield a couple of frames so React+Ink REPAINT the clean
      // frame BEFORE we unmount. Ink's unmount does a final re-render of the current tree;
      // with `finished` already flushed, that frame is just the <Static> transcript — so
      // scrollback no longer keeps a ghost input box / footer above the next idle prompt
      // (the "se duplica el input en cada tarea" bug). Each step is independently
      // swallowed: a teardown fault must never propagate (it would unwind into the
      // self-heal loop) and resumeInput() must ALWAYS run so stdin returns to the editor.
      try {
        inkHandle.finish();
      } catch {
        /* best-effort */
      }
      await new Promise((resolve) => setTimeout(resolve, RAIL_FINALIZE_MS));
      try {
        inkHandle.unmount();
      } catch {
        /* a rail teardown fault must never propagate — nunca es nunca */
      }
      try {
        deps.ui.resumeInput();
      } catch {
        /* re-arming is best-effort; the next question() re-enables raw lazily */
      }
    }
    options.signal?.removeEventListener('abort', onParentAbort);
  }

  if (inkHandle === null) {
    // Non-TTY recap: a static rail of the recorded stream.
    deps.ui.write();
    for (const line of renderRail(reduceRail(runManager.readEvents(run.id), reduceOpts), {
      tier,
      mode,
      labels: railLabels,
    })) {
      deps.ui.write(line);
    }
  }

  // The one-shot CLI footer (run id · artifacts · "inspect with") is run-tracker
  // jargon the conversational m-shell must NOT speak — there, the caller renders
  // the warm turn receipt instead. `excalibur run` keeps the full footer.
  if (!conversational) {
    deps.ui.write();
    if (record.status === 'completed') {
      deps.ui.success(deps.t('run-pipeline.runCompleted', { id: run.id }));
    } else {
      deps.ui.warn(deps.t('run-pipeline.runFinishedStatus', { id: run.id, status: record.status }));
    }
    deps.ui.info(deps.t('run-pipeline.artifacts', { dir: run.dir }));
    deps.ui.info(deps.t('run-pipeline.inspectWith', { id: run.id }));
  }

  // P1.10 — self-correction against REAL compiler diagnostics. With --diagnostics,
  // after the run, typecheck the result; if errors remain, run ONE bounded repair
  // pass (a real agentic run on the actual tsc output) and re-check. Runs on a
  // FAILED run too — a run failed by the claim ledger's `no_type_errors` is
  // exactly when a repair is wanted. Opt-in + recursion-guarded; the repair sees
  // real errors, never hallucinated ones. (A cancelled run is left alone.)
  if (
    options.diagnostics === true &&
    options.internalRepair !== true &&
    record.status !== 'cancelled'
  ) {
    // Do NOT repair a run that hit the hard budget cap — a repair would spend a
    // fresh full budget again (double-spend past the ceiling the user set).
    const budgetExhausted = runManager
      .readEvents(run.id)
      .some((e) => e.type === 'error' && e.payload['code'] === 'budget_exceeded');
    if (budgetExhausted) {
      deps.ui.warn(deps.t('diagnostics.skipBudget'));
    } else {
      await selfCorrectWithDiagnostics(deps, repoRoot, config, task, options);
    }
  }

  if (options.sync === true) {
    await pushLatestRun(deps, run.id);
  }
  return record;
}

/** One bounded diagnostics-driven repair pass (P1.10). */
async function selfCorrectWithDiagnostics(
  deps: CliDeps,
  repoRoot: string,
  config: { commands?: { typecheck?: string } },
  task: string,
  options: RunTaskOptions,
): Promise<void> {
  const typecheck = config.commands?.typecheck;
  const before = runDiagnostics(repoRoot, typecheck);
  if (!before.ran) {
    deps.ui.info(deps.t('diagnostics.noTypecheck'));
    return;
  }
  if (before.ok === true) {
    deps.ui.success(deps.t('diagnostics.cleanAfter'));
    return;
  }
  deps.ui.warn(deps.t('diagnostics.repairing', { count: before.diagnostics.length || 0 }));
  const repairTask =
    `Fix these REAL compiler errors from \`${typecheck}\` (change only what is needed; do not touch unrelated code):\n\n` +
    `${before.output}\n\nOriginal task for context: ${task}`;
  // Recursion-guarded real agentic run. `structured` drives the REAL read+write
  // agent loop (agent_work) — fast-fix's one-shot chat patch can't reliably edit
  // an existing file. Auto-approve so it is non-interactive.
  await runTask(deps, repairTask, {
    style: 'structured',
    yes: true,
    internalRepair: true,
    ...(options.budgetUsd !== undefined ? { budgetUsd: options.budgetUsd } : {}),
  });
  const after = runDiagnostics(repoRoot, typecheck);
  if (after.ok === true) {
    deps.ui.success(deps.t('diagnostics.repaired'));
  } else {
    deps.ui.warn(deps.t('diagnostics.stillErrors', { count: after.diagnostics.length || 0 }));
  }
}
