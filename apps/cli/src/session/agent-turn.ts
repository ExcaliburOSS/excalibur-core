import { NativeAgentAdapter, type AgentAdapter, type ConfirmationRequest } from '@excalibur/agent-runtime';
import { buildTurnSummary, loadReplay, RunManager, turnSummaryToMarkdown } from '@excalibur/core';
import {
  createEvent,
  generateId,
  type AgentRole,
  type AutonomyLevel,
  type ExcaliburConfig,
  type ExcaliburEvent,
  type LocalRun,
} from '@excalibur/shared';
import type { ModelGateway } from '@excalibur/model-gateway';
import pc from 'picocolors';
import type { CliDeps } from '../deps';
import { describeEvent } from '../lib/run-pipeline';
import { renderTurnReceipt } from '../lib/turn-receipt';

/**
 * The model-FIRST conversational turn (M-Shell). A natural-language line is
 * handed straight to the real agentic loop ({@link NativeAgentAdapter}): the
 * MODEL decides whether to answer (read tools) or to edit/run (write tools),
 * governed by the session's autonomy level. There is NO keyword classifier
 * pre-deciding intent — this is the opencode/Claude-Code shape.
 *
 * Every turn is recorded as a real RunManager run (its own
 * `.excalibur/runs/<id>/` with `events.jsonl`), so a turn is replayable /
 * time-machine-able later. Tool approvals are inline (`confirm` →
 * `deps.ui.confirm`, respecting the safety preset's `[y/N]` default) and Ctrl-C
 * cancels the in-flight turn (`signal`).
 *
 * Mock-degraded vs real-agentic: with the mock provider the loop returns the
 * templated text answer (the mock requests no tools) — a graceful offline demo.
 * With a real provider the model drives the full read/edit/run loop.
 */

/** What an agent turn dispatch reports back to the REPL transcript. */
export interface AgentTurnResult {
  /** The final assistant text (the model's answer / summary). */
  text: string;
  /** Provider/model that answered. */
  model: string;
  /** Accumulated cost in cents across the turn's model calls (null if unknown). */
  costCents: number | null;
  /** The run id this turn produced (the events.jsonl lives there). */
  runId: string;
  /** Whether the loop mutated the working tree (a patch was generated). */
  mutated: boolean;
}

export interface AgentTurnDeps {
  deps: CliDeps;
  repoRoot: string;
  config: ExcaliburConfig;
  gateway: ModelGateway;
  /** Provider name (e.g. `mock`) for status/transcript attribution. */
  providerName: string;
  /** The session's autonomy level — governs the role and approval strength. */
  autonomyLevel: AutonomyLevel;
  /** Cancels the in-flight turn (Ctrl-C). */
  signal?: AbortSignal;
  /** Injectable adapter (tests pass a fake-gateway-backed native adapter). */
  adapter?: AgentAdapter;
}

/**
 * Maps the autonomy level onto the agent role for a conversational turn.
 *
 * - L0 Review / L1 Assist → `planner`: the read-only tool subset (read, list,
 *   search, diff). The model answers / advises; it can NEVER mutate the tree.
 * - L2 / L3 / L4 → `implementer`: the full tool set (read + write + run),
 *   gated by inline confirmations for anything the permission engine flags.
 */
export function roleForAutonomy(level: AutonomyLevel): AgentRole {
  return level <= 1 ? 'planner' : 'implementer';
}

/** Strength of the inline approval default, from the autonomy level. */
function approvalDefaultYes(level: AutonomyLevel): boolean {
  // L4 (full agentic) defaults to approve; everything below defaults to the
  // safe `[y/N]` (no — mutations need an explicit yes).
  return level >= 4;
}

/** Renders one streamed agent event to the terminal (reuses the run renderer). */
function renderEvent(deps: CliDeps, event: ExcaliburEvent): void {
  const line = describeEvent(event);
  if (line !== null) {
    deps.ui.write(line);
  }
}

/**
 * Renders the post-turn receipt: a deterministic recap built from the run's
 * event stream (files changed, checks, cost) plus the model's final narrative.
 * Replaces a bare "print the final text" — the receipt SCALES to the work (a
 * plain answer is just the narrative + a footer; an action turn adds the
 * diffstat/file-list/next-step), and it persists the canonical `summary.md` so
 * the time-machine and Enterprise sync inherit it. Best-effort: a render/parse
 * failure never breaks the turn.
 */
function emitReceipt(
  turn: AgentTurnDeps,
  runManager: RunManager,
  runId: string,
  model: string,
): void {
  let summary;
  try {
    summary = buildTurnSummary(loadReplay(turn.repoRoot, runId));
  } catch {
    return;
  }
  try {
    runManager.writeArtifact(runId, 'summary.md', turnSummaryToMarkdown(summary));
  } catch {
    // Persisting the summary artifact is non-fatal.
  }
  renderTurnReceipt(turn.deps, summary, { now: new Date(), model });
}

interface DriveOptions {
  role: AgentRole;
  prompt: string;
  /** Inline tool-approval default (`[Y/n]` vs `[y/N]`). */
  approvalDefaultYes: boolean;
  /** When false, no tool approvals are offered (read-only planner pass). */
  allowConfirm: boolean;
}

interface DriveResult {
  finalText: string;
  costCents: number | null;
  model: string;
  mutated: boolean;
  aborted: boolean;
}

/**
 * Drives ONE pass of the native agent loop against a run, streaming + recording
 * events, and collects the final assistant text, cost, model and whether the
 * tree was mutated.
 */
async function driveLoop(
  turn: AgentTurnDeps,
  adapter: AgentAdapter,
  runManager: RunManager,
  run: LocalRun,
  sessionId: string,
  options: DriveOptions,
): Promise<DriveResult> {
  const { deps } = turn;
  let finalText = '';
  let costCents: number | null = null;
  let model = turn.providerName;
  let mutated = false;
  let aborted = false;

  const confirm = async (req: ConfirmationRequest): Promise<boolean> => {
    const detail = req.detail !== undefined ? ` (${req.detail})` : '';
    deps.ui.write(pc.yellow(`  ⚠ ${req.tool} needs approval: ${req.reason}${detail}`));
    return deps.ui.confirm('  Allow this action?', {
      defaultYes: options.approvalDefaultYes,
    });
  };

  const stream = adapter.run({
    runId: run.id,
    sessionId,
    workdir: turn.repoRoot,
    prompt: options.prompt,
    role: options.role,
    config: turn.config,
    gateway: turn.gateway,
    ...(turn.signal !== undefined ? { signal: turn.signal } : {}),
    ...(options.allowConfirm ? { confirm } : {}),
  });

  for await (const event of stream) {
    runManager.appendEvent(run.id, event);
    renderEvent(deps, event);

    if (event.type === 'model_call') {
      const m = event.payload['model'];
      if (typeof m === 'string' && m.length > 0) {
        model = m;
      }
      const c = event.payload['costCents'];
      if (typeof c === 'number') {
        costCents = (costCents ?? 0) + c;
      }
      const inputTokens = event.payload['inputTokens'];
      const outputTokens = event.payload['outputTokens'];
      if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
        runManager.appendModelCall(run.id, {
          provider: turn.config.models?.default ?? turn.providerName,
          model: typeof m === 'string' ? m : turn.providerName,
          inputTokens,
          outputTokens,
          costCents: typeof c === 'number' ? c : null,
          timestamp: new Date().toISOString(),
        });
      }
    }
    if (event.type === 'assistant_message') {
      const content = event.payload['content'];
      if (typeof content === 'string' && content.length > 0) {
        finalText = content;
      }
      if (event.payload['aborted'] === true) {
        aborted = true;
      }
    }
    if (event.type === 'patch_generated') {
      const diff = event.payload['diff'];
      if (typeof diff === 'string' && diff.trim().length > 0) {
        mutated = true;
        runManager.writeArtifact(run.id, 'diff.patch', `${diff}\n`);
      }
      const affected = event.payload['filesAffected'];
      if (Array.isArray(affected) && affected.length > 0) {
        mutated = true;
      }
    }
  }

  return { finalText, costCents, model, mutated, aborted };
}

/**
 * Creates a fresh RunManager run for one conversational turn. The run is the
 * unit of replay: its `events.jsonl` records the whole loop.
 */
function createTurnRun(
  runManager: RunManager,
  task: string,
  level: AutonomyLevel,
  providerName: string,
  workflow: string,
): LocalRun {
  return runManager.createRun({
    title: task,
    autonomyLevel: level,
    workflow,
    methodology: null,
    model: providerName,
    executionStyle: 'team_default',
  });
}

/**
 * Runs a single model-driven conversational turn (no plan gate). The role is
 * derived from the autonomy level; the model decides whether to answer or act.
 */
export async function runAgentTurn(turn: AgentTurnDeps, task: string): Promise<AgentTurnResult> {
  const adapter = turn.adapter ?? new NativeAgentAdapter();
  const runManager = new RunManager(turn.repoRoot);
  const role = roleForAutonomy(turn.autonomyLevel);
  const run = createTurnRun(
    runManager,
    task,
    turn.autonomyLevel,
    turn.providerName,
    role === 'planner' ? 'conversation-ask' : 'conversation',
  );
  runManager.updateRecord(run.id, { status: 'running' });

  turn.deps.ui.info(`→ agent · ${role === 'planner' ? 'answer (read-only)' : 'act'} · L${turn.autonomyLevel}`);
  turn.deps.ui.info(`Run ${run.id} → ${run.dir}`);

  const result = await driveLoop(turn, adapter, runManager, run, generateId('sess'), {
    role,
    prompt: task,
    approvalDefaultYes: approvalDefaultYes(turn.autonomyLevel),
    allowConfirm: role !== 'planner',
  });

  finishRun(turn.deps, runManager, run, result.aborted);
  emitReceipt(turn, runManager, run.id, result.model || turn.providerName);
  return toResult(run.id, result, turn.providerName);
}

/** Outcome of presenting a plan to the user. */
export type PlanGate = 'approve' | 'edit' | 'cancel';

export interface PlanTurnResult {
  /** What the user decided at the plan gate. */
  gate: PlanGate;
  /** The plan text the planner produced (always present). */
  planText: string;
  /** The execution result, present only when the plan was approved + executed. */
  execution: AgentTurnResult | null;
  /** The plan run id (always present — the plan is a real run too). */
  planRunId: string;
}

/**
 * Plan-mode: run the loop with the READ-ONLY planner role first to PRODUCE a
 * plan (read/list/search tools, no mutation), present it, then gate on
 * `[approve / edit / cancel]`:
 *  - approve → re-run with the implementer role (write tools) to EXECUTE;
 *  - edit    → returns `gate: 'edit'` so the REPL can amend + re-plan;
 *  - cancel  → stops (no execution).
 *
 * The plan and the execution are SEPARATE runs (each replayable). The gate is
 * skipped (auto-approve) on a non-interactive Ui — the safe default there is to
 * present the plan and stop, so a piped session never executes a plan blind;
 * we therefore return `gate: 'cancel'` when non-interactive.
 */
export async function runPlanTurn(turn: AgentTurnDeps, task: string): Promise<PlanTurnResult> {
  const adapter = turn.adapter ?? new NativeAgentAdapter();
  const runManager = new RunManager(turn.repoRoot);

  // --- 1. Plan pass (planner role, read-only) ------------------------------
  const planRun = createTurnRun(runManager, task, turn.autonomyLevel, turn.providerName, 'plan');
  runManager.updateRecord(planRun.id, { status: 'running' });
  turn.deps.ui.info(`→ plan · planner (read-only) · L${turn.autonomyLevel}`);
  turn.deps.ui.info(`Run ${planRun.id} → ${planRun.dir}`);

  const planResult = await driveLoop(turn, adapter, runManager, planRun, generateId('sess'), {
    role: 'planner',
    prompt: `Produce a concise, numbered implementation plan for the following task. Use read-only tools to ground the plan in the actual repository; do NOT modify anything.\n\nTask: ${task}`,
    approvalDefaultYes: false,
    allowConfirm: false,
  });
  finishRun(turn.deps, runManager, planRun, planResult.aborted);

  // Present the plan.
  turn.deps.ui.write();
  turn.deps.ui.heading('Plan');
  turn.deps.ui.write(planResult.finalText);
  turn.deps.ui.write();

  if (planResult.aborted) {
    return { gate: 'cancel', planText: planResult.finalText, execution: null, planRunId: planRun.id };
  }

  // --- 2. Gate -------------------------------------------------------------
  // Non-interactive: present + stop (never execute a plan blind in CI/piped).
  if (!turn.deps.ui.isInteractive()) {
    turn.deps.ui.info('Plan ready. Re-run with approval to execute (non-interactive: not executing).');
    return { gate: 'cancel', planText: planResult.finalText, execution: null, planRunId: planRun.id };
  }

  const answer = (
    await turn.deps.ui.ask('[approve / edit / cancel]', { defaultAnswer: 'cancel' })
  )
    .trim()
    .toLowerCase();
  const gate: PlanGate =
    answer === 'approve' || answer === 'a' || answer === 'y' || answer === 'yes'
      ? 'approve'
      : answer === 'edit' || answer === 'e'
        ? 'edit'
        : 'cancel';

  if (gate === 'edit') {
    turn.deps.ui.info('Edit the task and re-plan.');
    return { gate, planText: planResult.finalText, execution: null, planRunId: planRun.id };
  }
  if (gate === 'cancel') {
    turn.deps.ui.info('Plan cancelled. Nothing was changed.');
    return { gate, planText: planResult.finalText, execution: null, planRunId: planRun.id };
  }

  // --- 3. Execute pass (implementer role, write tools) ---------------------
  const execRun = createTurnRun(runManager, task, turn.autonomyLevel, turn.providerName, 'conversation');
  runManager.updateRecord(execRun.id, { status: 'running' });
  turn.deps.ui.write();
  turn.deps.ui.info(`→ execute · implementer · L${turn.autonomyLevel}`);
  turn.deps.ui.info(`Run ${execRun.id} → ${execRun.dir}`);

  const execResult = await driveLoop(turn, adapter, runManager, execRun, generateId('sess'), {
    role: 'implementer',
    prompt: `Execute this approved plan for the task. Make the changes using the available tools.\n\nTask: ${task}\n\nApproved plan:\n${planResult.finalText}`,
    approvalDefaultYes: approvalDefaultYes(turn.autonomyLevel),
    allowConfirm: true,
  });
  finishRun(turn.deps, runManager, execRun, execResult.aborted);
  emitReceipt(turn, runManager, execRun.id, execResult.model || turn.providerName);

  return {
    gate: 'approve',
    planText: planResult.finalText,
    execution: toResult(execRun.id, execResult, turn.providerName),
    planRunId: planRun.id,
  };
}

/** Marks the run completed/cancelled and emits a final `run_completed` event. */
function finishRun(deps: CliDeps, runManager: RunManager, run: LocalRun, aborted: boolean): void {
  const status = aborted ? 'cancelled' : 'completed';
  runManager.updateRecord(run.id, { status, completedAt: new Date().toISOString() });
  const event = createEvent({ runId: run.id, type: 'run_completed', payload: { status } });
  runManager.appendEvent(run.id, event);
  renderEvent(deps, event);
}

function toResult(runId: string, result: DriveResult, providerName: string): AgentTurnResult {
  return {
    text: result.finalText.length > 0 ? result.finalText : 'Done.',
    model: result.model || providerName,
    costCents: result.costCents,
    runId,
    mutated: result.mutated,
  };
}
