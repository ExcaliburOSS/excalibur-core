import {
  RunManager,
  addAnnotation,
  loadAnnotations,
  loadReplay,
  nextStepOfKind,
  prevStepOfKind,
  reconstructStateAt,
  type Annotation,
  type JumpKind,
  type ReplayModel,
  type ReplayStep,
} from '@excalibur/core';
import type { ChatMessage } from '@excalibur/model-gateway';
import type { AutonomyLevel } from '@excalibur/shared';
import pc from 'picocolors';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { chatWithGuidance, loadConfigContext, loadGatewayContext, streamWithGuidance } from './context';
import { runForkTurn, runUndo, type AgentTurnDeps } from '../session/agent-turn';

/**
 * The Excalibur time-machine scrubber (replay · inspect · explain · annotate).
 *
 * A readline-driven "video player" over a run's deterministic event log: scrub
 * step-by-step, semantic-jump to the next edit / test / command / failure /
 * approval / phase, EXPLAIN at the cursor (the gateway answers "why here, given
 * the task and what happened so far" — mock offline, real provider live), view
 * the accumulated diff, and pin annotations that resurface on revisit.
 *
 * Both the `excalibur replay` command and the in-session `/replay` reuse this:
 * the command wires the gateway/run resolution, this drives the loop. It degrades
 * gracefully: a non-interactive stdin (no TTY) prints a static linear summary
 * (`--print`) or the reconstructed state at a step (`--at <n>`) and returns —
 * fully scriptable and testable without a live terminal.
 */

const RECENT_LINES = 4;

/** Resolves a run by id (or the latest run when omitted). */
export function resolveRun(deps: CliDeps, runId: string | undefined): { id: string } {
  const manager = new RunManager(deps.cwd());
  const run = runId !== undefined ? manager.getRun(runId) : manager.latestRun();
  if (run === null) {
    throw new CliUsageError('No local runs yet. Start one with: excalibur run "<task>"');
  }
  return { id: run.id };
}

/** Cost rendered as a dollar figure, or `—` when unknown. */
function formatCost(costCents: number | null): string {
  return costCents === null ? '—' : `$${(costCents / 100).toFixed(2)}`;
}

/** The header: run id · title · workflow · autonomy · status · total cost. */
function renderHeader(deps: CliDeps, model: ReplayModel): void {
  const { run, steps } = model;
  const totalCost = steps.length > 0 ? steps[steps.length - 1]?.costCentsSoFar ?? null : null;
  deps.ui.heading(`⏮  Replay ${run.id} — ${run.title}`);
  deps.ui.info(
    `${run.workflow} · L${run.autonomyLevel} · ${run.status} · ${steps.length} steps · total ${formatCost(totalCost)}`,
  );
}

/** Renders the position line + the current step + a few surrounding events. */
function renderStep(
  deps: CliDeps,
  model: ManagedReplay,
  cursor: number,
): void {
  const state = reconstructStateAt(model.replay, cursor);
  const step = state.step;
  const total = model.replay.steps.length;
  const phase = step.phaseName !== null ? `phase ${step.phaseName}` : 'no phase';

  deps.ui.write();
  deps.ui.write(
    `${pc.bold(`step ${cursor + 1}/${total}`)} · ${pc.cyan(phase)} · ${pc.dim(step.event.type)} · ${pc.dim(formatCost(step.costCentsSoFar))}`,
  );
  deps.ui.write(`  ${pc.bold('→')} ${step.summary}`);

  // A short window of surrounding event summaries for context.
  const windowStart = Math.max(0, cursor - RECENT_LINES);
  for (let index = windowStart; index < cursor; index += 1) {
    const prior = model.replay.steps[index] as ReplayStep;
    deps.ui.write(`    ${pc.dim(`${index + 1}.`)} ${pc.dim(prior.summary)}`);
  }

  // Inline annotations pinned to this step (resurface on revisit).
  const pinned = model.annotations.filter((annotation) => annotation.stepIndex === cursor);
  for (const annotation of pinned) {
    deps.ui.write(`  ${pc.yellow('📌')} ${pc.yellow(annotation.note)} ${pc.dim(`(${annotation.at})`)}`);
  }
}

/** A static, linear summary of every step (the non-TTY / `--print` view). */
export function printLinearSummary(deps: CliDeps, replay: ReplayModel, annotations: Annotation[]): void {
  renderHeader(deps, replay);
  if (replay.steps.length === 0) {
    deps.ui.info('No events recorded for this run.');
    return;
  }
  for (const step of replay.steps) {
    const phase = step.phaseName !== null ? `[${step.phaseName}]` : '';
    deps.ui.write(
      `${String(step.index + 1).padStart(3)}. ${step.summary}  ${pc.dim(`${phase} ${formatCost(step.costCentsSoFar)}`)}`.trimEnd(),
    );
    for (const annotation of annotations.filter((a) => a.stepIndex === step.index)) {
      deps.ui.write(`     ${pc.yellow('📌')} ${pc.yellow(annotation.note)}`);
    }
  }
  deps.ui.write();
  const last = replay.steps[replay.steps.length - 1];
  deps.ui.info(`Total cost: ${formatCost(last?.costCentsSoFar ?? null)}`);
}

/** Prints the reconstructed state at a single step (the `--at <n>` view). */
export function printStateAt(
  deps: CliDeps,
  replay: ReplayModel,
  annotations: Annotation[],
  at: number,
): void {
  renderHeader(deps, replay);
  if (replay.steps.length === 0) {
    deps.ui.info('No events recorded for this run.');
    return;
  }
  const state = reconstructStateAt(replay, at);
  const step = state.step;
  deps.ui.write();
  deps.ui.write(`${pc.bold(`step ${step.index + 1}/${replay.steps.length}`)} · ${state.phaseName ?? 'no phase'}`);
  deps.ui.write(`  → ${step.summary}`);
  deps.ui.info(`  cost so far: ${formatCost(state.costCentsSoFar)}`);
  if (state.recentEvents.length > 0) {
    deps.ui.write(pc.dim('  recent:'));
    for (const event of state.recentEvents) {
      deps.ui.write(pc.dim(`    - ${event.type}`));
    }
  }
  for (const annotation of annotations.filter((a) => a.stepIndex === step.index)) {
    deps.ui.write(`  ${pc.yellow('📌')} ${pc.yellow(annotation.note)}`);
  }
  deps.ui.write();
  deps.ui.write(pc.dim('--- accumulated diff at cursor ---'));
  deps.ui.write(state.accumulatedDiff.length > 0 ? state.accumulatedDiff : pc.dim('(no diff reconstructable at this point)'));
}

/** Replay state held in memory during an interactive scrub. */
interface ManagedReplay {
  replay: ReplayModel;
  annotations: Annotation[];
}

/** Renders the one-line control help. */
function renderControls(deps: CliDeps): void {
  deps.ui.info(
    'controls: n/p step · ⏎ next phase · e edit · t test · c command · x failure · a approval · ' +
      'g <n> goto · 0/$ first/last · d diff · ? explain · pin <note> · ' +
      pc.bold('f fork') + ' · ' + pc.bold('u undo') + ' · q quit',
  );
}

/**
 * Fork-from-cursor: prompt for an instruction (reusing the scrubber's single
 * line reader — safe, no raw-key hazard) and run {@link runForkTurn} at the
 * current 0-based step. Reconstructs the worktree at this point and runs only
 * the new instruction live, reusing the cached prefix. Errors (no git repo, a
 * diff that won't reconstruct) are surfaced without breaking the scrub loop.
 */
async function forkFromCursor(
  deps: CliDeps,
  options: { question: (prompt: string) => Promise<string | null> },
  runId: string,
  repoRoot: string,
  cursor: number,
  autonomyLevel: AutonomyLevel,
): Promise<void> {
  const answer = await options.question(pc.cyan('fork instruction › '));
  const instruction = (answer ?? '').trim();
  if (instruction.length === 0) {
    deps.ui.info('Fork cancelled — no instruction given.');
    return;
  }
  try {
    const { config } = loadConfigContext(deps.cwd());
    const gateway = loadGatewayContext(deps.cwd());
    const turn: AgentTurnDeps = {
      deps,
      repoRoot,
      config,
      gateway: gateway.gateway,
      providerName: gateway.providerName,
      // Inherit the SOURCE run's autonomy — a fork must not silently escalate
      // (L0/L1 review-only) or downgrade (L4 auto) the level the run ran at.
      autonomyLevel,
    };
    const result = await runForkTurn(turn, { sourceRunId: runId, atStep: cursor, instruction });
    deps.ui.info(`Fork ${result.forkRunId} created — replay it: excalibur replay ${result.forkRunId}`);
  } catch (error) {
    deps.ui.error(error instanceof Error ? error.message : String(error));
  }
}

/** Explains the cursor: asks the gateway "why here, given task + history so far". */
async function explainAtCursor(deps: CliDeps, model: ManagedReplay, cursor: number): Promise<void> {
  const state = reconstructStateAt(model.replay, cursor);
  const { run } = model.replay;

  // Build a compact "what happened so far" trace from the events up to the cursor.
  const trace = model.replay.steps
    .slice(0, cursor + 1)
    .map((step) => `${step.index + 1}. ${step.summary}`)
    .join('\n');

  const phaseLine = state.phaseName !== null ? `Active phase: ${state.phaseName}.` : 'No active phase.';
  const diffBlock =
    state.accumulatedDiff.length > 0
      ? `\n\nAccumulated diff so far:\n\`\`\`diff\n${state.accumulatedDiff}\n\`\`\``
      : '';

  const prompt =
    `Task: ${run.title}\n\n` +
    `${phaseLine}\n\n` +
    `Here is what happened so far in this run, up to the current step:\n${trace}\n\n` +
    `The current step is: "${state.step.summary}" (${state.step.event.type}).${diffBlock}\n\n` +
    'Why did you do this here, given the task and what happened so far? Explain the reasoning concisely.';

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are the Excalibur agent narrating your own past run. Given the task and the trace of ' +
        'what happened so far, explain why the current step was taken. Be concise and specific.',
    },
    { role: 'user', content: prompt },
  ];

  const gatewayContext = loadGatewayContext(deps.cwd());
  const chatInput = { messages, metadata: { kind: 'explain' as const } };

  deps.ui.write();
  deps.ui.write(pc.bold(`Why step ${cursor + 1}? ${state.step.summary}`));
  deps.ui.write();
  if (deps.ui.isInteractive()) {
    await streamWithGuidance(deps, gatewayContext, chatInput, (chunk) => deps.ui.streamChunk(chunk));
    deps.ui.write();
    deps.ui.write();
  } else {
    const { output } = await chatWithGuidance(deps, gatewayContext, chatInput);
    deps.ui.write(output.content);
    deps.ui.write();
  }
}

/** Shows the accumulated diff at the cursor (`d`). */
function showDiff(deps: CliDeps, model: ManagedReplay, cursor: number): void {
  const state = reconstructStateAt(model.replay, cursor);
  deps.ui.write();
  deps.ui.write(pc.dim('--- accumulated diff at cursor ---'));
  if (state.accumulatedDiff.length > 0) {
    deps.ui.write(state.accumulatedDiff);
  } else {
    deps.ui.info('(no diff reconstructable at this point in the run)');
  }
  deps.ui.write();
}

/** Jumps to the next step of a kind, reporting when there is none. */
function jump(deps: CliDeps, model: ManagedReplay, cursor: number, kind: JumpKind): number {
  const next = nextStepOfKind(model.replay, cursor, kind);
  if (next === null) {
    deps.ui.info(`No further ${kind} step after here.`);
    return cursor;
  }
  return next;
}

/** Jumps to the next phase boundary's start (the ⏎ / `>` control). */
function jumpNextPhase(deps: CliDeps, model: ManagedReplay, cursor: number): number {
  const next = nextStepOfKind(model.replay, cursor, 'phase');
  if (next === null) {
    deps.ui.info('No further phase boundary after here.');
    return cursor;
  }
  return next;
}

/**
 * The interactive scrubber loop. Reads single-key / short commands from the
 * shared line editor (so it works against a real TTY and scripted memory
 * streams alike) and mutates the cursor until `q` / EOF. `at` (ISO timestamp)
 * is injected for deterministic annotation timestamps in tests.
 */
export async function runScrubber(
  deps: CliDeps,
  runId: string,
  options: {
    /** Line reader: the command opens its own editor; `/replay` passes the session's. */
    question: (prompt: string) => Promise<string | null>;
    /** ISO timestamp for new annotations (defaults to now). */
    now?: () => string;
  },
): Promise<void> {
  const repoRoot = deps.cwd();
  const model: ManagedReplay = {
    replay: loadReplay(repoRoot, runId),
    annotations: loadAnnotations(repoRoot, runId),
  };
  const now = options.now ?? ((): string => new Date().toISOString());

  renderHeader(deps, model.replay);
  if (model.replay.steps.length === 0) {
    deps.ui.info('No events recorded for this run — nothing to replay.');
    return;
  }
  renderControls(deps);

  const lastIndex = model.replay.steps.length - 1;
  let cursor = 0;
  renderStep(deps, model, cursor);

  for (;;) {
    const line = await options.question(pc.cyan('replay › '));
    if (line === null) {
      break; // EOF / Ctrl-D
    }
    const text = line.trim();
    const [head, ...rest] = text.split(/\s+/);
    const command = (head ?? '').toLowerCase();
    const argument = rest.join(' ');

    if (command === 'q' || command === 'quit' || command === 'exit') {
      break;
    }

    let moved = true;
    switch (command) {
      case '':
      case 'n':
      case 'next':
        cursor = Math.min(lastIndex, cursor + 1);
        break;
      case 'p':
      case 'prev':
        cursor = Math.max(0, cursor - 1);
        break;
      case 'space':
      case 'play': {
        // Auto-advance a few steps (kept simple/testable: no real timers).
        cursor = Math.min(lastIndex, cursor + 3);
        break;
      }
      case '>':
      case 'phase':
        cursor = jumpNextPhase(deps, model, cursor);
        break;
      case 'e':
      case 'edit':
        cursor = jump(deps, model, cursor, 'edit');
        break;
      case 't':
      case 'test':
        cursor = jump(deps, model, cursor, 'test');
        break;
      case 'c':
      case 'command':
        cursor = jump(deps, model, cursor, 'command');
        break;
      case 'x':
      case 'fail':
      case 'failure':
        // `f` is reserved for fork; the failure jump lives on `x` (error/✗).
        cursor = jump(deps, model, cursor, 'failure');
        break;
      case 'a':
      case 'approval':
        cursor = jump(deps, model, cursor, 'approval');
        break;
      case 'b':
      case 'back':
        // Backward semantic jump to the previous edit (a handy mirror of `e`).
        cursor = prevStepOfKind(model.replay, cursor, 'edit') ?? cursor;
        break;
      case 'g':
      case 'goto': {
        const target = Number.parseInt(argument, 10);
        if (Number.isNaN(target) || target < 1 || target > model.replay.steps.length) {
          deps.ui.warn(`Usage: g <n> (1..${model.replay.steps.length}).`);
          moved = false;
        } else {
          cursor = target - 1;
        }
        break;
      }
      case '0':
      case 'first':
        cursor = 0;
        break;
      case '$':
      case 'last':
        cursor = lastIndex;
        break;
      case 'd':
      case 'diff':
        showDiff(deps, model, cursor);
        moved = false;
        break;
      case '?':
      case 'explain':
        await explainAtCursor(deps, model, cursor);
        moved = false;
        break;
      case 'pin':
      case 'annotate': {
        if (argument.trim().length === 0) {
          deps.ui.warn('Usage: pin <note> — annotate the current step.');
          moved = false;
          break;
        }
        const annotation = addAnnotation(repoRoot, runId, {
          stepIndex: cursor,
          note: argument,
          at: now(),
        });
        model.annotations.push(annotation);
        deps.ui.success(`Pinned a note to step ${cursor + 1}.`);
        moved = false;
        break;
      }
      case 'f':
      case 'fork': {
        // Fork-from-HERE: reconstruct this step in an isolated worktree and run
        // a new instruction live, reusing the cached prefix (zero re-spend). The
        // cursor (0-based) IS the fork point. runForkTurn renders its own
        // progress + receipt; we just redraw the source step afterward.
        await forkFromCursor(deps, options, runId, repoRoot, cursor, model.replay.run.autonomyLevel);
        renderStep(deps, model, cursor);
        moved = false;
        break;
      }
      case 'u':
      case 'undo': {
        // Undo-to-HERE: revert the working tree to this step (gated + pre-flight).
        try {
          await runUndo(deps, runId, cursor, { yes: false });
        } catch (error) {
          deps.ui.warn(error instanceof Error ? error.message : String(error));
        }
        renderStep(deps, model, cursor);
        moved = false;
        break;
      }
      case 'h':
      case 'help':
      case '?h':
        renderControls(deps);
        moved = false;
        break;
      default:
        deps.ui.warn(`Unknown control: ${command}. Type 'h' for controls, 'q' to quit.`);
        moved = false;
        break;
    }

    if (moved) {
      renderStep(deps, model, cursor);
    }
  }
}
