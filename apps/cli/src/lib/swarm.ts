import { cpus } from 'node:os';
import { NativeAgentAdapter } from '@excalibur/agent-runtime';
import {
  applyPatch,
  capTotalAgents,
  chooseConcurrency,
  planAgentAllocation,
  runSwarm,
  SWARM_MAX_TOTAL_AGENTS,
  type Subtask,
  type SwarmLaneGrader,
  type SwarmLaneProgress,
  type SwarmResult,
} from '@excalibur/core';
import {
  applyCustomColors,
  detectColorTier,
  detectThemeSync,
  paletteFor,
  parseDiffStat,
  renderLanes,
  type LaneModel,
} from '@excalibur/tui';
import type { GatewayChatInput, ModelGateway } from '@excalibur/model-gateway';
import type { ExcaliburConfig, ExcaliburEvent } from '@excalibur/shared';
import type { CliDeps } from '../deps';
import { loadInkUi } from '../ink/load';
import type { LanesViewHandle } from '@excalibur/tui/ink';

/**
 * Swarm planning + execution glue for `excalibur swarm` (M3): a real model
 * decomposes a task into INDEPENDENT subtasks, `planAgentAllocation` sizes the
 * swarm, and `runSwarm` runs one real native-agent loop per subtask in an
 * isolated worktree, fanning the results in. Decomposition is defensive — a
 * non-parseable / single-unit task falls back to one lane (just runs the task).
 */

/** One decomposed unit: a subtask the swarm runs as its own lane. */
export interface SwarmSubtask {
  id: string;
  title: string;
  instruction: string;
  /**
   * Ids of OTHER subtasks this one depends on (AO3b). Empty/absent = independent
   * (wave 0). Carried into the staged executor's topological levelization so a
   * dependent lane runs only after its predecessors' merged result.
   */
  dependsOn?: ReadonlyArray<string>;
}

/**
 * Extracts the first balanced JSON object from model output (fence-tolerant).
 * Scans for the first `{` then matches braces (string/escape aware) to its close
 * — far more robust than a greedy `/\{[\s\S]*\}/`, which over-captures trailing
 * prose/fences and fails to parse. Shared by {@link decomposeTask} and the lane
 * grader.
 */
export function parseFirstJsonObject(content: string): Record<string, unknown> | null {
  const start = content.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < content.length; i += 1) {
    const ch = content[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const value = JSON.parse(content.slice(start, i + 1)) as unknown;
          return typeof value === 'object' && value !== null
            ? (value as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Asks the model to split `task` into up to `maxSubtasks` INDEPENDENT subtasks
 * (no two touching the same files), each a self-contained implementer
 * instruction. Falls back to a single lane (the whole task) when the model
 * returns nothing usable or only one unit.
 */
export async function decomposeTask(
  chat: { chat(input: GatewayChatInput): Promise<{ content: string }> },
  task: string,
  options: { provider?: string; maxSubtasks?: number; signal?: AbortSignal } = {},
): Promise<SwarmSubtask[]> {
  const max = options.maxSubtasks ?? 4;
  const system =
    'You split a coding task into INDEPENDENT subtasks that can be implemented in PARALLEL by ' +
    'separate agents — no two subtasks may touch the same files. Return ONLY a JSON object: ' +
    `{"subtasks":[{"title": string, "instruction": string}]}, at most ${max} entries. Each ` +
    '`instruction` is a complete, self-contained implementer prompt. If the task is small or not ' +
    'safely parallelizable, return a SINGLE subtask (the whole task). No prose, no code fences.';
  let parsed: Record<string, unknown> | null = null;
  try {
    const out = await chat.chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: task },
      ],
      maxTokens: 900,
      metadata: { kind: 'swarm-decompose' },
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    parsed = parseFirstJsonObject(out.content);
  } catch {
    parsed = null;
  }
  const raw = Array.isArray(parsed?.['subtasks']) ? (parsed!['subtasks'] as unknown[]) : [];
  const subtasks: SwarmSubtask[] = raw
    .map((entry, index): SwarmSubtask | null => {
      if (typeof entry !== 'object' || entry === null) return null;
      const e = entry as Record<string, unknown>;
      const instruction = typeof e['instruction'] === 'string' ? e['instruction'].trim() : '';
      if (instruction.length === 0) return null;
      const title =
        typeof e['title'] === 'string' && e['title'].trim().length > 0
          ? e['title'].trim()
          : `subtask ${index + 1}`;
      return { id: `t${index + 1}`, title, instruction };
    })
    .filter((s): s is SwarmSubtask => s !== null)
    .slice(0, max);
  // Fallback: one lane that runs the whole task.
  return subtasks.length > 0
    ? subtasks
    : [{ id: 't1', title: task.slice(0, 60), instruction: task }];
}

/** Maps decomposed subtasks to the allocator's `Subtask[]` (all independent). */
export function asAllocationSubtasks(subtasks: ReadonlyArray<SwarmSubtask>): Subtask[] {
  return subtasks.map((s) => ({ id: s.id, title: s.title }));
}

/**
 * AO2 auto-orchestration shape decision (pure). A build is parallelized into a
 * swarm only when it lives in a git repo — lanes need isolated worktrees to
 * merge — AND the task decomposed into ≥2 INDEPENDENT subtasks. Otherwise it
 * runs as a single focused sequential run. Excalibur makes this call itself; the
 * user never picks or sizes the shape.
 */
export function chooseBuildShape(input: {
  isRepo: boolean;
  subtaskCount: number;
}): 'swarm' | 'sequential' {
  return input.isRepo && input.subtaskCount >= 2 ? 'swarm' : 'sequential';
}

/** A lane's execution summary (events folded into counts). */
export interface SwarmLaneSummary {
  costCents: number | null;
  toolCalls: number;
}

/**
 * A model-backed lane grader (the rubric): asks the model whether a lane's diff
 * FULLY satisfies its subtask, returning pass + one line of revise feedback.
 * An empty diff never passes; a judge error is conservatively treated as pass
 * (a flaky judge must not block otherwise-good work).
 */
export function makeLaneGrader(
  chat: { chat(input: GatewayChatInput): Promise<{ content: string }> },
  options: { provider?: string; signal?: AbortSignal } = {},
): SwarmLaneGrader<SwarmLaneSummary> {
  return async ({ lane, diff }) => {
    if (diff.trim().length === 0) {
      return { pass: false, feedback: 'No changes were produced — implement the subtask.' };
    }
    const system =
      'You are a strict reviewer grading whether a DIFF fully and correctly implements a SUBTASK. ' +
      'Reply with ONLY a JSON object {"pass": boolean, "feedback": string}: pass=true only when the ' +
      'diff completely satisfies the subtask; feedback = ONE concrete sentence on what to fix ' +
      '(empty string when pass). No prose, no code fences.';
    const user = `Subtask:\n${lane.instruction}\n\nDiff:\n${diff.slice(0, 12000)}`;
    try {
      const out = await chat.chat({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        maxTokens: 200,
        metadata: { kind: 'swarm-grade' },
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      const parsed = parseFirstJsonObject(out.content);
      const pass = parsed?.['pass'] === true;
      const feedback =
        typeof parsed?.['feedback'] === 'string' && parsed['feedback'].trim().length > 0
          ? parsed['feedback'].trim()
          : undefined;
      return { pass, ...(feedback !== undefined ? { feedback } : {}) };
    } catch {
      return { pass: true }; // never block on a flaky judge
    }
  };
}

/** The lane's prompt: the subtask, plus a REVISE directive carrying the grader's
 * feedback when a prior attempt was rejected. */
function lanePrompt(instruction: string, feedback: string | undefined): string {
  if (feedback === undefined || feedback.trim().length === 0) {
    return instruction;
  }
  return (
    `${instruction}\n\nA prior attempt was REJECTED by code review. Revise your ` +
    `implementation to fully address this feedback:\n${feedback}`
  );
}

/**
 * Runs the decomposed subtasks as a real swarm: each lane drives the real
 * {@link NativeAgentAdapter} in its isolated worktree against the gateway.
 */
export function executeSwarm(
  deps: CliDeps,
  repoRoot: string,
  subtasks: ReadonlyArray<SwarmSubtask>,
  context: { gateway: ModelGateway; config: ExcaliburConfig; autonomyAutoApprove: boolean },
  options: {
    maxConcurrency?: number;
    maxAttempts?: number;
    signal?: AbortSignal;
    onLane?: (progress: SwarmLaneProgress) => void;
    grade?: SwarmLaneGrader<SwarmLaneSummary>;
  } = {},
): Promise<SwarmResult<SwarmLaneSummary>> {
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const swarmOptions = {
    ...(options.maxConcurrency !== undefined ? { maxConcurrency: options.maxConcurrency } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.onLane !== undefined ? { onLane: options.onLane } : {}),
    ...(options.grade !== undefined ? { grade: options.grade } : {}),
  };
  return runSwarm(
    repoRoot,
    subtasks.map((s) => ({ id: s.id, instruction: s.instruction })),
    async ({ lane, worktreePath, feedback }): Promise<SwarmLaneSummary> => {
      const adapter = new NativeAgentAdapter();
      let costCents: number | null = null;
      let toolCalls = 0;
      // The native adapter SWALLOWS provider/network errors into a non-throwing
      // `error` event and finishes cleanly. Track it so a lane that errored
      // without doing any work THROWS — which is what lets `--retries` actually
      // re-dispatch a transient failure (runSwarm only retries on a throw).
      let lastError: string | null = null;
      for await (const event of adapter.run({
        runId: `swarm_${lane.id}`,
        sessionId: `swarm_${lane.id}`,
        workdir: worktreePath,
        prompt: lanePrompt(byId.get(lane.id)?.instruction ?? lane.instruction, feedback),
        role: 'implementer',
        config: context.config,
        gateway: context.gateway,
        confirm: () => Promise.resolve(context.autonomyAutoApprove),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      } as Parameters<NativeAgentAdapter['run']>[0])) {
        const e = event as ExcaliburEvent;
        if (e.type === 'tool_call') toolCalls += 1;
        if (e.type === 'error') {
          const msg = (e.payload as Record<string, unknown>)['message'];
          lastError = typeof msg === 'string' ? msg : 'agent error';
        }
        if (e.type === 'assistant_message') {
          const total = (e.payload as Record<string, unknown>)['totalCostCents'];
          if (typeof total === 'number') costCents = total;
        }
      }
      // The turn ended in an error AND accomplished nothing (no tool calls) →
      // treat as a (likely transient) lane failure so the retry loop fires.
      if (lastError !== null && toolCalls === 0) {
        throw new Error(lastError);
      }
      return { costCents, toolCalls };
    },
    swarmOptions,
  );
}

/** Context a swarm flow needs (already resolved by the command / the REPL session). */
export interface SwarmFlowContext {
  gateway: ModelGateway;
  providerName: string;
  config: ExcaliburConfig;
}

export interface SwarmFlowOptions {
  maxAgents?: number;
  /** Pre-decomposed subtasks. When provided the flow SKIPS its own decomposition
   * and uses these directly — so an auto-orchestrator that already decided the
   * task is parallelizable does not pay for (or risk diverging on) a second
   * decomposition. Omitted → the flow decomposes `task` itself. */
  subtasks?: ReadonlyArray<SwarmSubtask>;
  /** Apply the merged diff without prompting. */
  apply?: boolean;
  /** Skip prompts and accept safe defaults. */
  yes?: boolean;
  /** Re-dispatch a failed lane up to this many times (grader/rubric retry). */
  retries?: number;
  /** Grade each lane's diff against its subtask and REVISE failing lanes with
   * feedback until they pass or attempts run out (a below-bar lane is dropped
   * from the merge). Defaults attempts to 2 when set with no explicit --retries. */
  grade?: boolean;
  /** Cancels the in-flight swarm (ESC / Ctrl-C). */
  signal?: AbortSignal;
}

/**
 * The full end-to-end swarm flow shared by `excalibur swarm` AND the in-shell
 * `/swarm` command: decompose → size (allocator) → confirm → run REAL parallel
 * agents with a LIVE per-lane panel (flicker-free, TTY-gated) → fan-in → render
 * the lanes panel → offer to apply the merged diff. Extracted so the live swarm
 * lanes work identically from the batch command and from the interactive shell.
 */
export async function runSwarmFlow(
  deps: CliDeps,
  repoRoot: string,
  task: string,
  ctx: SwarmFlowContext,
  options: SwarmFlowOptions = {},
): Promise<void> {
  const signalOpt = options.signal !== undefined ? { signal: options.signal } : {};

  // Use caller-supplied subtasks when the orchestrator already decomposed (AO2);
  // otherwise decompose here (the `excalibur swarm` / `/swarm` entry points).
  let subtasks: ReadonlyArray<SwarmSubtask>;
  if (options.subtasks !== undefined && options.subtasks.length > 0) {
    subtasks = options.subtasks;
  } else {
    deps.ui.info(deps.t('swarm.decomposing'));
    subtasks = await decomposeTask(ctx.gateway, task, {
      provider: ctx.providerName,
      ...(options.maxAgents !== undefined ? { maxSubtasks: options.maxAgents } : {}),
      ...signalOpt,
    });
  }

  // Fail-closed total-agent backstop: the auto path never fans out beyond
  // SWARM_MAX_TOTAL_AGENTS; a power-user `--max-agents N` opts into its own
  // (possibly higher) ceiling. A runaway decomposition can never DoS the box.
  const totalCap = capTotalAgents(options.maxAgents ?? SWARM_MAX_TOTAL_AGENTS, options.maxAgents);
  const allocation = planAgentAllocation({
    taskType: 'feature',
    sensitive: false,
    subtasks: asAllocationSubtasks(subtasks),
    maxAgents: totalCap,
  });
  const lanes = subtasks.slice(0, allocation.agentCount);
  // How many lanes run AT ONCE — sized from CPU headroom (and, later, budget).
  // Previously unset, so the pool defaulted to ALL lanes firing simultaneously.
  const concurrency = chooseConcurrency({
    laneCount: lanes.length,
    cpuCount: cpus().length,
    ...(options.maxAgents !== undefined ? { hardCap: options.maxAgents } : {}),
  });

  deps.ui.write();
  deps.ui.heading(deps.t('swarm.heading', { reason: allocation.reason }));
  lanes.forEach((subtask, index) => {
    deps.ui.write(`  ${index + 1}. ${subtask.title}`);
  });
  deps.ui.write();
  if (lanes.length === 1) {
    deps.ui.info(deps.t('swarm.singleUnit'));
  }

  const go =
    options.yes === true ||
    (await deps.ui.confirm(deps.t('swarm.confirmRun', { count: lanes.length }), {
      defaultYes: true,
    }));
  if (!go) {
    deps.ui.info(deps.t('swarm.cancelled'));
    return;
  }

  deps.ui.info(deps.t('swarm.running'));
  const tier = detectColorTier();
  const mode = detectThemeSync() ?? 'dark';
  const palette = applyCustomColors(
    paletteFor(ctx.config.ui?.theme ?? 'auto', mode),
    ctx.config.ui?.customTheme,
  );
  const railLabels = {
    swarm: deps.t('rail.swarm'),
    lanes: deps.t('rail.lanes'),
    merge: deps.t('rail.merge'),
    applied: deps.t('rail.applied'),
    conflict: deps.t('rail.conflict'),
  };
  // LIVE lanes: each lane lights up empty → running → done/failed as its agent
  // works (flicker-free, parallel). The Ink <LanesView> renders it on a TTY; a
  // non-TTY skips the live panel and prints the final one. The Ink panel is
  // output-ONLY (no useInput), so Ink never grabs raw mode — it coexists with the
  // REPL editor (which keeps ESC-to-cancel) with no stdin handoff.
  const laneSpecs = lanes.map((s) => ({ id: s.id, title: s.title }));
  let inkLanes: LanesViewHandle | null = null;
  if (deps.ui.isOutputTty()) {
    const ink = await loadInkUi();
    inkLanes = ink.mountLanesView({ palette, tier, mode, labels: railLabels, lanes: laneSpecs });
  }
  let result;
  try {
    // Grading enables the revise-until-it-passes loop; default to 2 attempts when
    // graded with no explicit --retries (so a rejected lane gets one revision).
    const gradeOn = options.grade === true;
    const maxAttempts =
      options.retries !== undefined && options.retries > 0
        ? options.retries + 1
        : gradeOn
          ? 2
          : undefined;
    // NOTE: executeSwarm takes context (4th) and options (5th) as SEPARATE args.
    // Previously everything was merged into the 4th object, so options defaulted
    // to {} and maxConcurrency/maxAttempts/grade/onLane/signal were SILENTLY
    // DROPPED (the spreads bypassed TS excess-property checks) — the live lanes
    // panel never animated, --grade/--retries no-opped, and ESC could not cancel
    // a swarm. Pass them in the OPTIONS arg where executeSwarm actually reads them.
    result = await executeSwarm(
      deps,
      repoRoot,
      lanes,
      {
        gateway: ctx.gateway,
        config: ctx.config,
        autonomyAutoApprove: true, // a parallel batch can't prompt per-lane
      },
      {
        maxConcurrency: concurrency,
        ...(maxAttempts !== undefined ? { maxAttempts } : {}),
        ...(gradeOn
          ? { grade: makeLaneGrader(ctx.gateway, { provider: ctx.providerName, ...signalOpt }) }
          : {}),
        ...signalOpt,
        ...(inkLanes !== null
          ? { onLane: (p: SwarmLaneProgress): void => inkLanes?.update(p) }
          : {}),
      },
    );

    // The SWARM LANES panel: concurrent sub-rails branching off the swarm node
    // and converging on a fan-in merge node — the visual payoff of the allocator.
    const conflictIds = new Set(result.conflicts.map((c) => c.id));
    const laneModels: LaneModel[] = result.lanes.map((lane) => {
      const subtask = lanes.find((s) => s.id === lane.id);
      const hasChanges = lane.diff.trim().length > 0;
      const state: LaneModel['state'] = lane.failed
        ? 'failed'
        : conflictIds.has(lane.id)
          ? 'conflict'
          : hasChanges
            ? 'done'
            : 'empty';
      return {
        id: lane.id,
        title: subtask?.title ?? lane.id,
        state,
        ...(lane.result?.toolCalls !== undefined ? { toolCalls: lane.result.toolCalls } : {}),
        ...(hasChanges ? { diff: parseDiffStat(lane.diff) } : {}),
        ...(lane.result?.costCents != null ? { costCents: lane.result.costCents } : {}),
        ...(lane.failed
          ? { detail: lane.error ?? 'failed' }
          : conflictIds.has(lane.id)
            ? { detail: 'merge conflict' }
            : {}),
      };
    });
    const applied = laneModels.filter((l) => l.state === 'done').length;
    const finalModel = { lanes: laneModels, applied, conflicts: result.conflicts.length };

    if (inkLanes !== null) {
      // Render the final detailed panel (per-lane diffstat/cost + merge counts)
      // as the Ink view's LAST frame; the `finally` unmounts it, leaving the
      // frame in scrollback. A short flush lets Ink paint it before teardown.
      inkLanes.setFinal(finalModel);
      await new Promise((resolve) => setTimeout(resolve, 60));
    } else {
      deps.ui.write();
      for (const line of renderLanes(finalModel, { tier, mode, palette, labels: railLabels })) {
        deps.ui.write(line);
      }
    }
  } finally {
    // ALWAYS tear down the live Ink panel — on success (after the final frame is
    // painted) AND on any throw in the swarm or the panel build. Idempotent.
    inkLanes?.unmount();
  }

  if (result.mergedDiff.trim().length === 0) {
    deps.ui.info(deps.t('swarm.noChanges'));
    return;
  }
  deps.ui.write();
  deps.ui.write(result.mergedDiff);

  // `--apply` and `-y/--yes` both apply without prompting (consistent with
  // `run --yes`, which auto-approves + applies edits). Otherwise prompt — safe
  // default NO, and a non-interactive stdin resolves to that no (never mutates
  // the working tree unasked). Note: passing `{ yes }` to confirm would return
  // the DEFAULT (no), not "yes" — hence the explicit short-circuit.
  const apply =
    options.apply === true ||
    options.yes === true ||
    (await deps.ui.confirm(deps.t('swarm.confirmApply'), { defaultYes: false }));
  if (!apply) {
    deps.ui.info(deps.t('swarm.leftUnapplied'));
    return;
  }
  try {
    applyPatch(repoRoot, result.mergedDiff);
    deps.ui.success(deps.t('swarm.applied'));
  } catch (error) {
    deps.ui.error(
      deps.t('swarm.applyFailed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
