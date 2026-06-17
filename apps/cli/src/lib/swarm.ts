import { NativeAgentAdapter } from '@excalibur/agent-runtime';
import {
  runSwarm,
  type Subtask,
  type SwarmLaneProgress,
  type SwarmResult,
} from '@excalibur/core';
import type { GatewayChatInput, ModelGateway } from '@excalibur/model-gateway';
import type { ExcaliburConfig, ExcaliburEvent } from '@excalibur/shared';
import type { CliDeps } from '../deps';

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
