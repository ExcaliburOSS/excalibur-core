import { NativeAgentAdapter } from '@excalibur/agent-runtime';
import {
  applyPatch,
  planAgentAllocation,
  runSwarm,
  type Subtask,
  type SwarmLaneProgress,
  type SwarmResult,
} from '@excalibur/core';
import {
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
import { LiveLanes } from './live-lanes';

/**
 * Swarm planning + execution glue for `excalibur swarm` (M3): a real model
 * decomposes a task into INDEPENDENT subtasks, `planAgentAllocation` sizes the
 * swarm, and `runSwarm` runs one real native-agent loop per subtask in an
 * isolated worktree, fanning the results in. Decomposition is defensive — a
 * non-parseable / single-unit task falls back to one lane (just runs the task).
 */

/** One decomposed unit: an independent subtask the swarm runs as its own lane. */
export interface SwarmSubtask {
  id: string;
  title: string;
  instruction: string;
}

/** Extracts the first JSON object from model output (fence-tolerant). */
function parseFirstJsonObject(content: string): Record<string, unknown> | null {
  const match = content.match(/\{[\s\S]*\}/);
  if (match === null) return null;
  try {
    const value = JSON.parse(match[0]) as unknown;
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
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
      const title = typeof e['title'] === 'string' && e['title'].trim().length > 0 ? e['title'].trim() : `subtask ${index + 1}`;
      return { id: `t${index + 1}`, title, instruction };
    })
    .filter((s): s is SwarmSubtask => s !== null)
    .slice(0, max);
  // Fallback: one lane that runs the whole task.
  return subtasks.length > 0 ? subtasks : [{ id: 't1', title: task.slice(0, 60), instruction: task }];
}

/** Maps decomposed subtasks to the allocator's `Subtask[]` (all independent). */
export function asAllocationSubtasks(subtasks: ReadonlyArray<SwarmSubtask>): Subtask[] {
  return subtasks.map((s) => ({ id: s.id, title: s.title }));
}

/** A lane's execution summary (events folded into counts). */
export interface SwarmLaneSummary {
  costCents: number | null;
  toolCalls: number;
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
    signal?: AbortSignal;
    onLane?: (progress: SwarmLaneProgress) => void;
  } = {},
): Promise<SwarmResult<SwarmLaneSummary>> {
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const swarmOptions = {
    ...(options.maxConcurrency !== undefined ? { maxConcurrency: options.maxConcurrency } : {}),
    ...(options.onLane !== undefined ? { onLane: options.onLane } : {}),
  };
  return runSwarm(
    repoRoot,
    subtasks.map((s) => ({ id: s.id, instruction: s.instruction })),
    async ({ lane, worktreePath }): Promise<SwarmLaneSummary> => {
      const adapter = new NativeAgentAdapter();
      let costCents: number | null = null;
      let toolCalls = 0;
      for await (const event of adapter.run({
        runId: `swarm_${lane.id}`,
        sessionId: `swarm_${lane.id}`,
        workdir: worktreePath,
        prompt: byId.get(lane.id)?.instruction ?? lane.instruction,
        role: 'implementer',
        config: context.config,
        gateway: context.gateway,
        confirm: () => Promise.resolve(context.autonomyAutoApprove),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      } as Parameters<NativeAgentAdapter['run']>[0])) {
        const e = event as ExcaliburEvent;
        if (e.type === 'tool_call') toolCalls += 1;
        if (e.type === 'assistant_message') {
          const total = (e.payload as Record<string, unknown>)['totalCostCents'];
          if (typeof total === 'number') costCents = total;
        }
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
  /** Apply the merged diff without prompting. */
  apply?: boolean;
  /** Skip prompts and accept safe defaults. */
  yes?: boolean;
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

  deps.ui.info(deps.t('swarm.decomposing'));
  const subtasks = await decomposeTask(ctx.gateway, task, {
    provider: ctx.providerName,
    ...(options.maxAgents !== undefined ? { maxSubtasks: options.maxAgents } : {}),
    ...signalOpt,
  });

  const allocation = planAgentAllocation({
    taskType: 'feature',
    sensitive: false,
    subtasks: asAllocationSubtasks(subtasks),
    ...(options.maxAgents !== undefined ? { maxAgents: options.maxAgents } : {}),
  });
  const lanes = subtasks.slice(0, allocation.agentCount);

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
  const palette = paletteFor(ctx.config.ui?.theme ?? 'auto', mode);
  const railLabels = {
    swarm: deps.t('rail.swarm'),
    lanes: deps.t('rail.lanes'),
    merge: deps.t('rail.merge'),
    applied: deps.t('rail.applied'),
    conflict: deps.t('rail.conflict'),
  };
  // LIVE: each lane lights up empty → running → done/failed as its agent works
  // (flicker-free, parallel). On a non-TTY we skip it and print the final panel.
  const live = deps.ui.isOutputTty()
    ? new LiveLanes(
        { writeRaw: (t) => deps.ui.writeRaw(t) },
        {
          tier,
          mode,
          palette,
          labels: railLabels,
          lanes: lanes.map((s) => ({ id: s.id, title: s.title })),
        },
      )
    : null;
  live?.start();
  let result;
  try {
    result = await executeSwarm(deps, repoRoot, lanes, {
      gateway: ctx.gateway,
      config: ctx.config,
      autonomyAutoApprove: true, // a parallel batch can't prompt per-lane
      ...signalOpt,
      ...(live !== null ? { onLane: (p: SwarmLaneProgress) => live.update(p) } : {}),
    });
  } finally {
    live?.finish();
  }

  // The SWARM LANES panel: concurrent sub-rails branching off the swarm node and
  // converging on a fan-in merge node — the visual payoff of the allocator.
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

  deps.ui.write();
  for (const line of renderLanes(
    { lanes: laneModels, applied, conflicts: result.conflicts.length },
    { tier, mode, palette, labels: railLabels },
  )) {
    deps.ui.write(line);
  }

  if (result.mergedDiff.trim().length === 0) {
    deps.ui.info(deps.t('swarm.noChanges'));
    return;
  }
  deps.ui.write();
  deps.ui.write(result.mergedDiff);

  const apply =
    options.apply === true ||
    (await deps.ui.confirm(deps.t('swarm.confirmApply'), {
      yes: options.yes,
      defaultYes: false,
    }));
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
