import { NativeAgentAdapter, type AgentAdapter, type ConfirmationRequest } from '@excalibur/agent-runtime';
import {
  addWorktree,
  applyPatch,
  buildTurnSummary,
  checkPatchApplies,
  commitAll,
  EXCALIBUR_DIR,
  getGitInfo,
  hasCommits,
  loadReplay,
  planFork,
  planUndo,
  removeWorktree,
  restampEventsForFork,
  RunManager,
  turnSummaryToMarkdown,
} from '@excalibur/core';
import {
  createEvent,
  generateId,
  type AgentRole,
  type AutonomyLevel,
  type ExcaliburConfig,
  type ExcaliburEvent,
  type LocalRun,
} from '@excalibur/shared';
import type { ChatMessage, ModelGateway } from '@excalibur/model-gateway';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pc from 'picocolors';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { describeEvent } from '../lib/run-pipeline';
import { renderTurnReceipt } from '../lib/turn-receipt';
import { ActionRenderer, activityFor } from '../lib/action-render';

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
  /** Working directory the loop operates in (defaults to the repo root; a fork
   * passes its isolated worktree). */
  workdir?: string;
  /** Cached conversation prefix for fork-from-cache (seeds the loop). */
  seedMessages?: ChatMessage[];
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
  let totalTokens = 0;
  const turnStart = Date.now();
  const unicode = deps.env['EXCALIBUR_ASCII'] === undefined;

  // The breathing "thinking/working" indicator (transient; animates only on a
  // real TTY). Its text is GROUNDED: the live tool activity when one is running,
  // a phase/role gerund while the model just reasons — plus live tok·$·elapsed.
  const spinner = deps.ui.createSpinner({ unicode });
  // Ctrl-C: the SIGINT handler aborts cooperatively and writes "Cancelled"
  // immediately, but the loop may keep awaiting the in-flight model call. Cancel
  // the indicator SYNCHRONOUSLY on abort so its next frame can't overwrite that
  // message (and it never re-arms). Listener removed in the finally below.
  const onAbort = (): void => spinner.cancel();
  turn.signal?.addEventListener('abort', onAbort);
  const gerund = gerundForRole(options.role);
  const spinnerText = (activity: string | null): string => {
    const label = activity ?? gerund;
    const cost = costCents !== null ? ` · $${(costCents / 100).toFixed(2)}` : '';
    const toks = totalTokens > 0 ? ` · ${compactTokens(totalTokens)} tok` : '';
    const elapsed = ` · ${Math.round((Date.now() - turnStart) / 1000)}s`;
    return `${label}${pc.dim(toks + cost + elapsed)}`;
  };

  const confirm = async (req: ConfirmationRequest): Promise<boolean> => {
    spinner.stop(); // clear the transient line before the (permanent) prompt
    const detail = req.detail !== undefined ? ` (${req.detail})` : '';
    deps.ui.write(pc.yellow(`  ⚠ ${req.tool} needs approval: ${req.reason}${detail}`));
    return deps.ui.confirm('  Allow this action?', {
      defaultYes: options.approvalDefaultYes,
    });
  };

  const stream = adapter.run({
    runId: run.id,
    sessionId,
    workdir: options.workdir ?? turn.repoRoot,
    prompt: options.prompt,
    role: options.role,
    config: turn.config,
    gateway: turn.gateway,
    ...(turn.signal !== undefined ? { signal: turn.signal } : {}),
    ...(options.allowConfirm ? { confirm } : {}),
    ...(options.seedMessages !== undefined ? { seedMessages: options.seedMessages } : {}),
  });

  // The live per-action renderer: groups the stream into tool blocks (header +
  // indented result), diffs and command output — the Claude-Code-class view.
  const renderer = new ActionRenderer(deps, { unicode });

  // Show the indicator during the FIRST wait (the opening model call). The loop
  // is wrapped so the spinner's timer is ALWAYS cleared, even if a write throws.
  spinner.start(() => spinnerText(null));

  try {
  for await (const event of stream) {
    spinner.stop(); // erase the transient line before any permanent output
    runManager.appendEvent(run.id, event);
    renderer.onEvent(event);

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
        totalTokens += inputTokens + outputTokens;
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

    // Re-arm the indicator for the NEXT wait: the grounded activity that follows
    // this event (a tool announcement → "Running …" during execution), else the
    // role gerund while the model reasons before the next turn.
    const activity = activityFor(event);
    spinner.start(() => spinnerText(activity));
  }
  } finally {
    spinner.stop();
    turn.signal?.removeEventListener('abort', onAbort);
  }
  renderer.finish();

  return { finalText, costCents, model, mutated, aborted };
}

/** Present-continuous label for the model "thinking" between tool calls, by role. */
function gerundForRole(role: AgentRole): string {
  switch (role) {
    case 'planner':
      return 'Planning…';
    case 'architect':
      return 'Designing…';
    case 'reviewer':
    case 'security':
      return 'Reviewing…';
    case 'tester':
      return 'Writing tests…';
    default:
      return 'Working…';
  }
}

/** Compact token count for the indicator (`12.4k`, `340`). */
function compactTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
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

/** `$0.04`, or `—` when no cost is known. */
function fmtCost(costCents: number | null): string {
  return costCents === null ? '—' : `$${(costCents / 100).toFixed(2)}`;
}

/**
 * Adds a pattern to `.git/info/exclude` (the local, uncommitted ignore list) so
 * a fork worktree never pollutes the user's `git status` / `git add`, regardless
 * of whether `.excalibur/` is gitignored. Best-effort: skips silently when `.git`
 * is absent or is a linked-worktree file rather than a directory.
 */
function excludeFromGit(repoRoot: string, pattern: string): void {
  try {
    const gitDir = join(repoRoot, '.git');
    if (!existsSync(gitDir)) {
      return;
    }
    const excludePath = join(gitDir, 'info', 'exclude');
    let current = '';
    try {
      current = readFileSync(excludePath, 'utf8');
    } catch {
      current = '';
    }
    if (current.split('\n').some((line) => line.trim() === pattern)) {
      return;
    }
    const prefix = current.length === 0 || current.endsWith('\n') ? '' : '\n';
    appendFileSync(excludePath, `${prefix}${pattern}\n`);
  } catch {
    // Best-effort — never fail a fork over the ignore list.
  }
}

/** Input to {@link runForkTurn}. `atStep` is 0-based (the CLI converts from 1-based). */
export interface ForkTurnInput {
  sourceRunId: string;
  atStep: number;
  instruction: string;
}

export interface ForkTurnResult {
  forkRunId: string;
  worktreePath: string;
  branch: string;
  cachedTokens: { input: number; output: number };
  cachedCostCents: number | null;
  execution: AgentTurnResult;
}

/**
 * Fork-from-cache (time-machine T2): branch a NEW run from step N of a source
 * run. The prefix (0..N) is replayed FROM CACHE — its events are copied into the
 * fork's log (marked cached) and its conversation reconstructed as the loop's
 * seed, so not a single token of the good work is re-spent — and only the new
 * `instruction` runs LIVE, in an isolated git worktree whose files are
 * reconstructed to the state at N. "Start from scratch" disappears.
 *
 * Safety: needs a git repo with a commit (the worktree base). If the run's
 * accumulated diff does not apply onto the current HEAD (the tree diverged) the
 * worktree is torn down and the fork fails cleanly rather than half-built.
 */
export async function runForkTurn(turn: AgentTurnDeps, input: ForkTurnInput): Promise<ForkTurnResult> {
  const { deps } = turn;
  const runManager = new RunManager(turn.repoRoot);

  if (!getGitInfo(turn.repoRoot).isRepo) {
    throw new Error('Fork needs a git repository — the worktree is reconstructed from a base commit.');
  }
  if (!hasCommits(turn.repoRoot)) {
    throw new Error('Fork needs at least one commit to base the reconstructed worktree on.');
  }

  const plan = planFork(turn.repoRoot, input.sourceRunId, input.atStep);
  if (plan.source.totalSteps === 0) {
    throw new Error(`Source run "${input.sourceRunId}" has no events to fork from.`);
  }

  const forkRun = runManager.createRun({
    title: input.instruction,
    autonomyLevel: turn.autonomyLevel,
    workflow: 'fork',
    methodology: null,
    model: turn.providerName,
    executionStyle: 'team_default',
  });
  runManager.updateRecord(forkRun.id, {
    status: 'running',
    forkedFrom: { runId: plan.source.runId, atStep: plan.source.atStep },
  });

  // Copy the cached prefix into the fork's log so the fork is itself replayable.
  for (const event of restampEventsForFork(plan.prefixEvents, forkRun.id)) {
    runManager.appendEvent(forkRun.id, event);
  }

  // Keep the worktree dir out of the user's git status regardless of whether
  // `.excalibur/` is gitignored (a nested worktree would otherwise show up /
  // get staged as a broken gitlink).
  excludeFromGit(turn.repoRoot, '.excalibur/worktrees/');

  const worktreePath = join(turn.repoRoot, EXCALIBUR_DIR, 'worktrees', forkRun.id);
  const branch = `excalibur/fork-${forkRun.id}`;
  addWorktree(turn.repoRoot, worktreePath, { branch });

  // From here, ANY failure must tear down the worktree and mark the run failed —
  // never leave an orphaned worktree or a run stuck "running".
  try {
    if (plan.baseDiff.trim().length > 0) {
      if (plan.baseDiff.includes('[REDACTED]')) {
        deps.ui.warn(
          'The reconstructed base contains [REDACTED] where a secret was scrubbed at capture — ' +
            'fill those in before relying on the forked worktree.',
        );
      }
      const check = checkPatchApplies(worktreePath, plan.baseDiff);
      applyPatch(worktreePath, plan.baseDiff, check.applies ? undefined : { threeway: true });
      // Commit the reconstructed base so the SUFFIX's diff is purely the new
      // work (not the replayed prefix). Best-effort: a repo without a usable
      // identity simply keeps the base uncommitted.
      commitAll(worktreePath, `excalibur: reconstructed base @ step ${plan.source.atStep + 1}`);
    }

    const cachedTokens = plan.cachedTokens.input + plan.cachedTokens.output;
    deps.ui.info(`⑂ fork of ${plan.source.runId} @ step ${plan.source.atStep + 1}/${plan.source.totalSteps}`);
    deps.ui.info(
      `Reused ${cachedTokens} cached tokens (${fmtCost(plan.cachedCostCents)}) — only the new instruction runs live.`,
    );
    deps.ui.info(`Worktree ${worktreePath} · branch ${branch}`);

    // Drive ONLY the live suffix: the implementer executes the new instruction
    // with the cached prefix seeded, inside the reconstructed worktree.
    const adapter = turn.adapter ?? new NativeAgentAdapter();
    const result = await driveLoop(turn, adapter, runManager, forkRun, generateId('sess'), {
      role: 'implementer',
      prompt: input.instruction,
      approvalDefaultYes: approvalDefaultYes(turn.autonomyLevel),
      allowConfirm: true,
      workdir: worktreePath,
      seedMessages: plan.seedMessages,
    });
    finishRun(deps, runManager, forkRun, result.aborted);
    emitReceipt(turn, runManager, forkRun.id, result.model || turn.providerName);

    return {
      forkRunId: forkRun.id,
      worktreePath,
      branch,
      cachedTokens: plan.cachedTokens,
      cachedCostCents: plan.cachedCostCents,
      execution: toResult(forkRun.id, result, turn.providerName),
    };
  } catch (error) {
    removeWorktree(turn.repoRoot, worktreePath, { force: true });
    runManager.updateRecord(forkRun.id, { status: 'failed', completedAt: new Date().toISOString() });
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Fork failed at step ${plan.source.atStep + 1}: ${reason}. ` +
        `The worktree was torn down; nothing in your working tree changed.`,
    );
  }
}

/**
 * Undo-to-checkpoint (time-machine T2): revert the WORKING TREE to a run's state
 * at step `atStep` (0-based). Shared by `excalibur undo`, the `/undo` shell
 * command and the scrubber's `u` key so the safety logic lives in ONE place.
 *
 * Conservative + gated: it reverse-applies the run's changes only after a
 * `git apply --check` pre-flight (a diverged tree aborts with NO mutation), then
 * re-applies up to the checkpoint — and if that re-apply will not land, it
 * RESTORES the original tree and throws, never leaving a half-state or a
 * silently-wrong step. Throws {@link CliUsageError} on the abort paths so the
 * command surfaces a clean usage error; callers inside a loop (the scrubber)
 * should try/catch and route the message to the UI.
 */
export async function runUndo(
  deps: CliDeps,
  runId: string,
  atStep: number,
  options: { yes?: boolean } = {},
): Promise<void> {
  const repoRoot = deps.cwd();
  const plan = planUndo(repoRoot, runId, atStep);

  if (plan.fullDiff.trim().length === 0) {
    deps.ui.info(`Run ${runId} recorded no file changes — nothing to undo.`);
    return;
  }

  // Pre-flight: can we cleanly unwind the run's changes from the tree?
  const canReverse = checkPatchApplies(repoRoot, plan.fullDiff, { reverse: true });
  if (!canReverse.applies) {
    throw new CliUsageError(
      `Cannot undo: the run's changes do not reverse-apply cleanly to your working tree ` +
        `(${canReverse.reason ?? 'diverged'}). The tree has changed since the run; resolve it first.`,
    );
  }

  deps.ui.warn(
    `This reverts your working tree to run ${runId}'s state at step ${plan.atStep + 1}/${plan.totalSteps}.`,
  );
  // Always confirm unless `-y`: `confirm` returns its default (false) when
  // non-interactive, so a piped/non-TTY undo ABORTS rather than silently
  // mutating the tree.
  if (options.yes !== true) {
    const ok = await deps.ui.confirm('Proceed?', { defaultYes: false });
    if (!ok) {
      deps.ui.info('Undo cancelled. Nothing was changed.');
      return;
    }
  }

  // Unwind the run's changes (pre-flighted above), bringing the tree to the base.
  applyPatch(repoRoot, plan.fullDiff, { reverse: true });

  if (plan.targetDiff.trim().length === 0) {
    deps.ui.info(pc.green("✓ Working tree reverted — the run's changes were undone."));
    return;
  }

  // Re-apply up to the checkpoint; on a non-applying target, RESTORE the original
  // tree (forward-apply) and abort — never silently land at a different step.
  const canReapply = checkPatchApplies(repoRoot, plan.targetDiff);
  if (!canReapply.applies) {
    applyPatch(repoRoot, plan.fullDiff);
    throw new CliUsageError(
      `Could not reconstruct step ${plan.atStep + 1} (${canReapply.reason ?? 'no clean apply'}). ` +
        `Your working tree was left UNCHANGED.`,
    );
  }
  applyPatch(repoRoot, plan.targetDiff);
  deps.ui.info(pc.green(`✓ Working tree reverted to step ${plan.atStep + 1}.`));
}
