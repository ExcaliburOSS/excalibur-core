import { cpus } from 'node:os';
import { NativeAgentAdapter } from '@excalibur/agent-runtime';
import {
  applyPatch,
  BudgetLedger,
  budgetCapCentsFromUsd,
  capTotalAgents,
  buildSchemaInstruction,
  chooseConcurrency,
  extractJsonValues,
  getLocalDiff,
  planAgentAllocation,
  RunManager,
  runSwarm,
  runSwarmStaged,
  stageAll,
  SWARM_MAX_TOTAL_AGENTS,
  topologicalWaves,
  validateAgainstSchema,
  type JsonSchema,
  type Subtask,
  type SwarmHeal,
  type SwarmLaneGrader,
  type SwarmLaneHealer,
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
import type { AgentRole, AutonomyLevel, ExcaliburConfig, ExcaliburEvent } from '@excalibur/shared';
import type { CliDeps } from '../deps';
import { loadInkUi } from '../ink/load';
import { runConfiguredCommandCheck } from './verify-command';
import { runProportionalMesh } from './verify-mesh';
import {
  buildOrchestrationManifest,
  loadOrchestrationControl,
  type OrchestrationPlan,
} from './orchestration-manifest';
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
  /**
   * AO5-4 — optional agent ROLE for this lane (author-defined orchestrations).
   * Defaults to `implementer`. A non-mutating role (reviewer/planner/…) gets the
   * read-only tool subset and so produces an empty diff — author specs should use
   * mutating roles for lanes meant to land changes.
   */
  role?: AgentRole;
  /**
   * AO7-4 — optional JSON-schema CONTRACT for this lane's final output. When set,
   * the lane is told to emit conforming JSON; its final message is validated and a
   * mismatch RE-DISPATCHES the lane (reusing the retry loop). The parsed value is
   * recorded on `SwarmLaneSummary.structuredOutput` (available for inspection /
   * a future fan-in consumer — not yet read by dependents). Best for analysis/data lanes.
   */
  outputSchema?: JsonSchema;
  /** AO7-2 — per-step attempt ceiling (loop-until-rubric), overrides the default. */
  maxAttempts?: number;
  /** AO7-2 — conditional execution vs this step's deps: always | on_success | on_failure. */
  when?: 'always' | 'on_success' | 'on_failure';
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
 * Asks the model to split `task` into up to `maxSubtasks` subtasks for parallel
 * agents in isolated worktrees. It PREFERS independent subtasks (different files)
 * but may express genuine ordering with `dependsOn` (1-based indices of
 * prerequisites) — the staged executor (AO3c) runs those in later waves on top of
 * their predecessors' merged result. Falls back to a single lane (the whole
 * task) when the model returns nothing usable.
 */
export async function decomposeTask(
  chat: { chat(input: GatewayChatInput): Promise<{ content: string }> },
  task: string,
  options: { provider?: string; maxSubtasks?: number; signal?: AbortSignal } = {},
): Promise<SwarmSubtask[]> {
  const max = options.maxSubtasks ?? 4;
  const system =
    'You split a coding task into subtasks for parallel agents, each in an isolated git worktree. ' +
    'PREFER independent subtasks (touching different files) so they run in parallel. When a subtask ' +
    'genuinely needs another done FIRST, list its prerequisites in "dependsOn" as the 1-based indices ' +
    'of the earlier subtasks it depends on (a dependent subtask runs in a LATER wave, on top of its ' +
    "predecessors' merged result). Return ONLY a JSON object: " +
    `{"subtasks":[{"title": string, "instruction": string, "dependsOn"?: number[]}]}, at most ${max} ` +
    'entries. Each "instruction" is a complete, self-contained implementer prompt. If the task is ' +
    'small or not safely decomposable, return a SINGLE subtask (the whole task). No prose, no code fences.';
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
      // dependsOn arrives as 1-based indices into this array; map to `t<n>` ids,
      // dropping out-of-range and self references. topologicalWaves later ignores
      // any id that falls outside the (post-slice) set, so this is safe.
      const dependsOn = Array.isArray(e['dependsOn'])
        ? (e['dependsOn'] as unknown[])
            .map((d) => (typeof d === 'number' ? Math.floor(d) : Number.NaN))
            .filter((n) => Number.isInteger(n) && n >= 1 && n !== index + 1)
            .map((n) => `t${n}`)
        : [];
      return {
        id: `t${index + 1}`,
        title,
        instruction,
        ...(dependsOn.length > 0 ? { dependsOn } : {}),
      };
    })
    .filter((s): s is SwarmSubtask => s !== null)
    .slice(0, max);
  // Fallback: one lane that runs the whole task.
  return subtasks.length > 0
    ? subtasks
    : [{ id: 't1', title: task.slice(0, 60), instruction: task }];
}

/**
 * AO6 Pillar 3 — the pause HOLD loop (pure, testable). Returns immediately when
 * not paused (or already aborted). Otherwise fires `onPause` once, then polls
 * `isPaused` (sleeping `pollMs` between checks) until it clears or `isAborted`
 * goes true, then fires `onResume`. The lane gate wraps this around its
 * model-spend; extracted so the hold/resume contract is unit-testable without a
 * live swarm.
 */
export async function holdWhilePaused(opts: {
  isPaused: () => boolean;
  isAborted: () => boolean;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  onPause?: () => void;
  onResume?: () => void;
}): Promise<void> {
  if (!opts.isPaused() || opts.isAborted()) return;
  opts.onPause?.();
  while (opts.isPaused() && !opts.isAborted()) {
    await opts.sleep(opts.pollMs);
  }
  opts.onResume?.();
}

/** Maps decomposed subtasks to the allocator's `Subtask[]`, carrying dependsOn
 * so the allocator counts only the wave-0 (independent) lanes. */
export function asAllocationSubtasks(subtasks: ReadonlyArray<SwarmSubtask>): Subtask[] {
  return subtasks.map((s) => ({
    id: s.id,
    title: s.title,
    ...(s.dependsOn !== undefined && s.dependsOn.length > 0 ? { dependsOn: s.dependsOn } : {}),
  }));
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
  /** AO7-4 — the lane's schema-validated structured output, when it declared one. */
  structuredOutput?: unknown;
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
export async function executeSwarm(
  deps: CliDeps,
  repoRoot: string,
  subtasks: ReadonlyArray<SwarmSubtask>,
  context: {
    gateway: ModelGateway;
    config: ExcaliburConfig;
    autonomyAutoApprove: boolean;
    /** Provider name recorded on the persisted runs (AO4a). */
    providerName?: string;
    /** Work item to link every child lane run to (AO4e). */
    workItemId?: string | null;
    /** The originating task text, recorded in the orchestration manifest (AO5). */
    task?: string;
  },
  options: {
    maxConcurrency?: number;
    maxAttempts?: number;
    signal?: AbortSignal;
    onLane?: (progress: SwarmLaneProgress) => void;
    grade?: SwarmLaneGrader<SwarmLaneSummary>;
    /** When present (and >1 wave), run the STAGED executor (AO3c) over these
     * dependency waves instead of a flat fan-out — a dependent wave sees its
     * predecessors' merged result. Each wave is the SwarmSubtasks for that level. */
    waves?: ReadonlyArray<ReadonlyArray<SwarmSubtask>>;
  } = {},
): Promise<SwarmResult<SwarmLaneSummary>> {
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  // AO5-5 — recursion depth: inherited from the env so a nested `excalibur swarm`
  // shelled by a lane self-caps; the core refuses to fan out at depth > 1. The
  // env is set to depth+1 around the executor run (below) so lane children inherit it.
  const swarmDepth = Number.parseInt(process.env['EXCALIBUR_SWARM_DEPTH'] ?? '0', 10) || 0;
  // AO5-6 — per-wave verification gate (STAGED only): verify each wave's merged
  // tree (configured test + mesh) at its boundary; a red verdict reverts the wave
  // so dependents base on the healthy tree. Opt-in via orchestration.verifyWaves.
  const meshCtx: SwarmFlowContext = {
    gateway: context.gateway,
    providerName: context.providerName ?? '',
    config: context.config,
  };
  const verifyWave =
    context.config.orchestration?.verifyWaves === true
      ? async (args: {
          waveIndex: number;
          waveDiff: string;
          mergePath: string;
        }): Promise<{ passed: boolean; revert?: boolean; detail?: string }> => {
          deps.ui.info(deps.t('swarm.verify-wave', { wave: args.waveIndex + 1 }));
          const checks = await runMergedTreeChecks(
            deps,
            meshCtx,
            args.mergePath,
            args.waveDiff,
            options.signal,
          );
          if (!checks.passed) {
            deps.ui.warn(
              deps.t('swarm.wave-reverted', {
                wave: args.waveIndex + 1,
                detail: checks.detail ?? '',
              }),
            );
            return {
              passed: false,
              revert: true,
              ...(checks.detail ? { detail: checks.detail } : {}),
            };
          }
          deps.ui.success(deps.t('swarm.wave-verified', { wave: args.waveIndex + 1 }));
          return { passed: true };
        }
      : undefined;
  const swarmOptions = {
    ...(options.maxConcurrency !== undefined ? { maxConcurrency: options.maxConcurrency } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.onLane !== undefined ? { onLane: options.onLane } : {}),
    ...(options.grade !== undefined ? { grade: options.grade } : {}),
    ...(verifyWave !== undefined ? { verifyWave } : {}),
    depth: swarmDepth,
  };

  // AO4a — SWARM-AS-RUN: persist parallel work as first-class runs so the shipped
  // observability plane (SSE, replay/fork, dashboard, audit, work-item linkage)
  // sees it. One PARENT run + one CHILD run per lane (linked by parentRunId), with
  // the lane's real events streamed to its child run. Lanes ride EXISTING event
  // types (the events.ts enum is frozen for Enterprise ingestion). Best-effort: a
  // run-store fault never breaks the swarm.
  const runManager = new RunManager(repoRoot);
  const level = (context.config.autonomy?.default ?? 3) as AutonomyLevel;
  const workItemId = context.workItemId ?? null;
  let parentId: string | null = null;
  try {
    const parent = runManager.createRun({
      title: `swarm: ${subtasks.length} lane${subtasks.length === 1 ? '' : 's'}`,
      autonomyLevel: level,
      workflow: 'swarm',
      model: context.providerName ?? null,
      ...(workItemId !== null ? { workItemId } : {}),
    });
    parentId = parent.id;
    runManager.updateRecord(parentId, { status: 'running' });
  } catch {
    parentId = null;
  }

  // AO6 Pillar 2 — persist the orchestration PLAN (the wave/DAG STRUCTURE) at
  // START, so the LIVE chronogram can render the DAG immediately and fill it
  // wave-by-wave as lanes progress (the outcome `orchestration.json` only lands
  // at the end). Each lane's `runId` is back-filled as its child run is created.
  const planStaged = options.waves !== undefined && options.waves.length > 1;
  const orchestrationPlan: OrchestrationPlan = {
    version: 1,
    task: context.task ?? subtasks.map((s) => s.title).join('; '),
    mode: planStaged ? 'staged' : 'flat',
    parentRunId: parentId ?? '',
    createdAt: new Date().toISOString(),
    waves: planStaged ? options.waves!.map((w) => w.map((s) => s.id)) : [subtasks.map((s) => s.id)],
    lanes: subtasks.map((s) => ({
      id: s.id,
      title: s.title,
      instruction: s.instruction,
      dependsOn: [...(s.dependsOn ?? [])],
    })),
  };
  const writePlan = (): void => {
    if (parentId === null) return;
    try {
      runManager.writeArtifact(
        parentId,
        'orchestration-plan.json',
        JSON.stringify(orchestrationPlan, null, 2),
      );
    } catch {
      /* best-effort — a plan write fault never breaks the swarm */
    }
  };
  writePlan();

  const childByLane = new Map<string, string>();
  const childRunFor = (laneId: string): string | null => {
    const existing = childByLane.get(laneId);
    if (existing !== undefined) return existing;
    if (parentId === null) return null;
    try {
      const child = runManager.createRun({
        title: byId.get(laneId)?.title ?? laneId,
        autonomyLevel: level,
        workflow: 'swarm-lane',
        model: context.providerName ?? null,
        parentRunId: parentId,
        ...(workItemId !== null ? { workItemId } : {}),
      });
      runManager.updateRecord(child.id, { status: 'running' });
      childByLane.set(laneId, child.id);
      // Back-fill the lane→child link so the live chronogram can attach state.
      const planLane = orchestrationPlan.lanes.find((l) => l.id === laneId);
      if (planLane !== undefined) {
        planLane.runId = child.id;
        writePlan();
      }
      return child.id;
    } catch {
      return null;
    }
  };

  // AO4c — the hard budget cap must BIND across the fan-out. ExecuteLocalRun's cap
  // only governs a single sequential loop, so a shared ledger over the lanes'
  // cost stops DISPATCHING new lanes once the cap is hit (worst-case overshoot:
  // the lanes already in flight, bounded by maxConcurrency). Cap from
  // budget.maxRunUsd; null = uncapped.
  const ledger = new BudgetLedger(budgetCapCentsFromUsd(context.config.budget?.maxRunUsd));
  let budgetNotified = false;

  // AO6 Pillar 3 — real mid-flight pause. The control flag (set cross-process by
  // the dashboard / a second CLI / NL) is polled at each lane's gate: while
  // paused, a not-yet-started lane HOLDS (no model spend) — the in-flight lanes
  // finish — and clearing it resumes the SAME swarm. A cancel (abort) breaks the
  // hold. Distinct from cancel, which tears the whole swarm down.
  const PAUSE_POLL_MS = 700;
  let pausedNotified = false;
  const isPaused = (): boolean =>
    parentId !== null && (loadOrchestrationControl(repoRoot, parentId)?.paused ?? false);
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const runLane = async ({
    lane,
    worktreePath,
    feedback,
  }: {
    lane: { id: string; instruction: string };
    worktreePath: string;
    feedback?: string;
  }): Promise<SwarmLaneSummary> => {
    // Pause gate (AO6 Pillar 3): HOLD a not-yet-started lane while the
    // orchestration is paused; clearing the flag resumes the same swarm.
    await holdWhilePaused({
      isPaused,
      isAborted: () => options.signal?.aborted ?? false,
      sleep,
      pollMs: PAUSE_POLL_MS,
      onPause: () => {
        if (parentId !== null && !pausedNotified) {
          pausedNotified = true;
          deps.ui.warn(deps.t('orchestration.paused-held'));
          try {
            runManager.updateRecord(parentId, { status: 'waiting_approval' });
          } catch {
            /* best-effort */
          }
        }
      },
      onResume: () => {
        if (parentId !== null && pausedNotified) {
          pausedNotified = false;
          try {
            runManager.updateRecord(parentId, { status: 'running' });
          } catch {
            /* best-effort */
          }
          if (!(options.signal?.aborted ?? false)) deps.ui.info(deps.t('orchestration.resumed'));
        }
      },
    });
    if (options.signal?.aborted ?? false) {
      return { costCents: 0, toolCalls: 0 };
    }
    // Budget gate: once the shared cap is hit, do NOT start another lane (no
    // model spend) — the already-merged lanes are the partial result.
    if (ledger.exceeded()) {
      if (!budgetNotified) {
        budgetNotified = true;
        deps.ui.warn(
          deps.t('swarm.budget-stopped', {
            spent: (ledger.spent / 100).toFixed(2),
            cap: ((ledger.cap ?? 0) / 100).toFixed(2),
          }),
        );
      }
      return { costCents: 0, toolCalls: 0 };
    }
    const childId = childRunFor(lane.id);
    const adapter = new NativeAgentAdapter();
    let costCents: number | null = null;
    let toolCalls = 0;
    // The native adapter SWALLOWS provider/network errors into a non-throwing
    // `error` event and finishes cleanly. Track it so a lane that errored
    // without doing any work THROWS — which is what lets `--retries` actually
    // re-dispatch a transient failure (runSwarm only retries on a throw).
    let lastError: string | null = null;
    // AO7-4 — when the lane declares an output schema, tell the agent to emit
    // conforming JSON and capture its final message to validate after the run.
    const outputSchema = byId.get(lane.id)?.outputSchema;
    let finalText = '';
    const baseInstruction = byId.get(lane.id)?.instruction ?? lane.instruction;
    const instruction =
      outputSchema !== undefined
        ? `${baseInstruction}\n\n${buildSchemaInstruction(outputSchema)}`
        : baseInstruction;
    for await (const event of adapter.run({
      runId: childId ?? `swarm_${lane.id}`,
      sessionId: `swarm_${lane.id}`,
      workdir: worktreePath,
      prompt: lanePrompt(instruction, feedback),
      role: byId.get(lane.id)?.role ?? 'implementer',
      config: context.config,
      gateway: context.gateway,
      confirm: () => Promise.resolve(context.autonomyAutoApprove),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    } as Parameters<NativeAgentAdapter['run']>[0])) {
      const e = event as ExcaliburEvent;
      // PERSIST every lane event to its child run (best-effort) so SSE/replay/
      // dashboard/audit see the parallel work in real time.
      if (childId !== null) {
        try {
          runManager.appendEvent(childId, e);
        } catch {
          /* a run-store write fault must never break the lane */
        }
      }
      if (e.type === 'tool_call') toolCalls += 1;
      if (e.type === 'error') {
        const msg = (e.payload as Record<string, unknown>)['message'];
        lastError = typeof msg === 'string' ? msg : 'agent error';
      }
      if (e.type === 'assistant_message') {
        const payload = e.payload as Record<string, unknown>;
        const total = payload['totalCostCents'];
        if (typeof total === 'number') costCents = total;
        const text = payload['text'];
        if (typeof text === 'string' && text.trim().length > 0) finalText = text;
      }
    }
    // Account this lane's spend so later lanes (and waves) see the running total
    // and stop once the cap is hit.
    ledger.add(costCents);
    // The turn ended in an error AND accomplished nothing (no tool calls) →
    // treat as a (likely transient) lane failure so the retry loop fires.
    if (lastError !== null && toolCalls === 0) {
      throw new Error(lastError);
    }
    // AO7-4 — enforce the lane's output schema: parse the final message and
    // validate. A mismatch THROWS → the retry/heal loop re-dispatches (the schema
    // instruction stays in the prompt so the re-attempt conforms). On success the
    // parsed value rides the summary to the fan-in / dependents.
    if (outputSchema !== undefined) {
      // AO7 review #7/#8 — among ALL embedded JSON values prefer the one that
      // VALIDATES (the model often echoes the schema/example FIRST), and reject when
      // NONE validates — incl. an empty/no-JSON capture — even for a type-less schema.
      const values = extractJsonValues(finalText);
      const value = values.find((v) => validateAgainstSchema(v, outputSchema).length === 0);
      if (value === undefined) {
        const why =
          values.length === 0
            ? 'no JSON object found in the output'
            : validateAgainstSchema(values[0], outputSchema).slice(0, 3).join('; ');
        throw new Error(`lane output did not match its schema: ${why}`);
      }
      return { costCents, toolCalls, structuredOutput: value };
    }
    return { costCents, toolCalls };
  };

  // AO5-5 — SELF-HEAL: when a lane exhausts its attempts, re-instruct it ONCE with
  // the failure context. Routed through runLane so the budget gate + pause + child
  // run events apply for free; bounded to a single heal (the core never re-enters).
  const healOptions: { heal?: SwarmLaneHealer<SwarmLaneSummary> } =
    context.config.orchestration?.selfHeal === true
      ? {
          heal: async ({
            lane,
            lastError,
            lastGrade,
            worktreePath,
          }): Promise<SwarmHeal<SwarmLaneSummary>> => {
            if (ledger.exceeded()) {
              return { healed: false }; // no budget left — don't spend on a heal
            }
            const ctx = [lastError, lastGrade?.feedback]
              .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
              .join(' — ');
            deps.ui.warn(deps.t('swarm.healing', { id: lane.id }));
            const summary = await runLane({
              lane: {
                id: lane.id,
                instruction: byId.get(lane.id)?.instruction ?? lane.instruction,
              },
              worktreePath,
              feedback: `Your previous attempts FAILED. Diagnose and fix the ROOT CAUSE — do not repeat the same approach. Failure context:\n${ctx}`,
            });
            stageAll(worktreePath);
            const diff = getLocalDiff(worktreePath);
            if (diff.trim().length === 0) {
              deps.ui.info(deps.t('swarm.heal-failed', { id: lane.id }));
              return { healed: false };
            }
            // Re-grade ONCE when a grader is set; else a non-empty corrective diff heals.
            if (options.grade !== undefined) {
              const g = await options.grade({ lane, diff, result: summary, attempt: 0 });
              if (!g.pass) {
                deps.ui.info(deps.t('swarm.heal-failed', { id: lane.id }));
                return { healed: false, grade: g };
              }
              deps.ui.success(deps.t('swarm.healed', { id: lane.id }));
              return { healed: true, result: summary, grade: g };
            }
            deps.ui.success(deps.t('swarm.healed', { id: lane.id }));
            return { healed: true, result: summary };
          },
        }
      : {};
  const execOptions = { ...swarmOptions, ...healOptions };

  // AO5-5 — inherit-able recursion depth: a nested `excalibur swarm` shelled by a
  // lane (the only nesting vector) inherits depth+1 and self-caps. Set around the
  // run, then restored so a long-lived REPL never leaks a stale depth.
  const prevDepthEnv = process.env['EXCALIBUR_SWARM_DEPTH'];
  process.env['EXCALIBUR_SWARM_DEPTH'] = String(swarmDepth + 1);
  // AO7-2 — carry per-step controls (maxAttempts loop-until + dependsOn/when
  // conditional) onto the core SwarmLane; the staged executor honours `when`.
  const toLane = (s: SwarmSubtask) => ({
    id: s.id,
    instruction: s.instruction,
    ...(s.maxAttempts !== undefined ? { maxAttempts: s.maxAttempts } : {}),
    ...(s.dependsOn !== undefined ? { dependsOn: s.dependsOn } : {}),
    ...(s.when !== undefined ? { when: s.when } : {}),
  });
  // STAGED (a real dependency graph) vs FLAT (a single parallel wave). AO7 review
  // #4 — `when` (conditional) is honoured ONLY by the staged executor, so force
  // staged whenever ANY lane declares a non-default `when`, even for a single wave
  // (otherwise a flat single-wave authored spec would run an on_failure/on_success
  // lane unconditionally).
  const hasConditional = subtasks.some((s) => s.when !== undefined && s.when !== 'always');
  const useStaged = options.waves !== undefined && (options.waves.length > 1 || hasConditional);
  let result: SwarmResult<SwarmLaneSummary>;
  try {
    result = useStaged
      ? await runSwarmStaged(
          repoRoot,
          (options.waves as ReadonlyArray<ReadonlyArray<SwarmSubtask>>).map((w) => w.map(toLane)),
          runLane,
          execOptions,
        )
      : await runSwarm(repoRoot, subtasks.map(toLane), runLane, execOptions);
  } finally {
    if (prevDepthEnv === undefined) {
      delete process.env['EXCALIBUR_SWARM_DEPTH'];
    } else {
      process.env['EXCALIBUR_SWARM_DEPTH'] = prevDepthEnv;
    }
  }

  // Finalize the persisted runs from the outcome (best-effort).
  const finishedAt = new Date().toISOString();
  for (const laneResult of result.lanes) {
    const childId = childByLane.get(laneResult.id);
    if (childId === undefined) continue;
    try {
      runManager.updateRecord(childId, {
        status: laneResult.failed ? 'failed' : 'completed',
        completedAt: finishedAt,
      });
    } catch {
      /* best-effort */
    }
  }
  if (parentId !== null) {
    try {
      const anyOk = result.lanes.some((l) => !l.failed);
      runManager.updateRecord(parentId, {
        status: result.lanes.length === 0 || anyOk ? 'completed' : 'failed',
        completedAt: finishedAt,
      });
    } catch {
      /* best-effort */
    }
    // AO5 — persist a re-runnable/inspectable orchestration MANIFEST on the parent
    // run (the foundation of Workflow-tool parity). Best-effort.
    try {
      const staged = options.waves !== undefined && options.waves.length > 1;
      const waveIds = staged
        ? options.waves!.map((w) => w.map((s) => s.id))
        : [subtasks.map((s) => s.id)];
      const manifest = buildOrchestrationManifest({
        task: context.task ?? subtasks.map((s) => s.title).join('; '),
        parentRunId: parentId,
        createdAt: finishedAt,
        mode: staged ? 'staged' : 'flat',
        subtasks,
        waves: waveIds,
        outcomes: result.lanes.map((l) => ({
          id: l.id,
          outcome: l.failed ? 'failed' : l.diff.trim().length > 0 ? 'done' : 'empty',
          costCents: l.result?.costCents ?? null,
          ...(childByLane.get(l.id) !== undefined ? { runId: childByLane.get(l.id)! } : {}),
        })),
      });
      runManager.writeArtifact(parentId, 'orchestration.json', JSON.stringify(manifest, null, 2));
    } catch {
      /* best-effort — a manifest write fault never breaks the swarm */
    }
  }
  return result;
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
  /** Internal: suppress the proactive "retry failed lanes?" offer (set on the
   * retry run itself, so a failed retry never loops the offer). */
  noResumeOffer?: boolean;
}

/**
 * AO4f — a proportional adversarial Verification-Mesh pass over the MERGED swarm
 * diff, so the parallel auto-build gets the same evidence-linked review the
 * formal `excalibur run` does. `planVerificationMesh` sizes the jury to the
 * change (docs → none); a surviving HIGH issue → blocked=true. Best-effort: a
 * flaky/erroring mesh NEVER blocks the merge.
 */
async function runMergeMesh(deps: CliDeps, ctx: SwarmFlowContext, diff: string): Promise<boolean> {
  const out = await runProportionalMesh(
    { gateway: ctx.gateway, providerName: ctx.providerName, config: ctx.config },
    diff,
  );
  if (out === null) {
    return false; // nothing warranted / best-effort skip
  }
  deps.ui.info(deps.t('swarm.mesh-running', { lenses: out.lenses }));
  for (const issue of out.result.issues) {
    const where = issue.file !== undefined ? `${issue.file} — ` : '';
    deps.ui.write(`  [${issue.severity.toUpperCase()}] ${where}${issue.problem}`);
  }
  return out.result.blocked;
}

/**
 * AO5-6 — the ground-truth checks behind BOTH the per-wave gate and the final
 * verified fan-in: run the configured test command against `cwd` (the merged
 * tree), then a proportional adversarial mesh over `diff`. Returns `passed:false`
 * with a reason on a red test OR a surviving HIGH issue; best-effort otherwise (a
 * missing command / flaky jury never blocks). The CALLER owns the revert.
 */
async function runMergedTreeChecks(
  deps: CliDeps,
  ctx: SwarmFlowContext,
  cwd: string,
  diff: string,
  signal: AbortSignal | undefined,
): Promise<{ passed: boolean; detail?: string }> {
  const verify = runConfiguredCommandCheck(cwd, ctx.config.commands?.test, signal);
  if (verify !== undefined) {
    const verdict = await verify();
    if (!verdict.passed) {
      return { passed: false, detail: verdict.detail };
    }
  }
  if (await runMergeMesh(deps, ctx, diff)) {
    return { passed: false, detail: 'verification mesh blocked (surviving high-severity issue)' };
  }
  return { passed: true };
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
  const lanes = subtasks.slice(0, totalCap);
  // Levelize into dependency WAVES (AO3c): a real graph (≥2 waves) runs STAGED —
  // each wave rebased on its predecessors' merged result; otherwise a single flat
  // parallel wave. A cycle (null) falls back to flat.
  const waves = topologicalWaves(lanes);
  const staged = waves !== null && waves.length > 1;
  // How many lanes run AT ONCE — sized from the WIDEST wave's CPU headroom.
  // (Previously maxConcurrency was unset, so the pool fired ALL lanes at once.)
  const widestWave = staged ? Math.max(...waves.map((w) => w.length)) : lanes.length;
  const concurrency = chooseConcurrency({
    laneCount: widestWave,
    cpuCount: cpus().length,
    ...(options.maxAgents !== undefined ? { hardCap: options.maxAgents } : {}),
  });

  deps.ui.write();
  if (staged) {
    deps.ui.heading(deps.t('swarm.staged-heading', { count: lanes.length, waves: waves.length }));
    waves.forEach((wave, w) => {
      deps.ui.write(`  ${deps.t('swarm.wave', { n: w + 1 })}`);
      wave.forEach((s) => deps.ui.write(`    • ${s.title}`));
    });
  } else {
    const allocation = planAgentAllocation({
      taskType: 'feature',
      sensitive: false,
      subtasks: asAllocationSubtasks(lanes),
      maxAgents: totalCap,
    });
    deps.ui.heading(deps.t('swarm.heading', { reason: allocation.reason }));
    lanes.forEach((subtask, index) => {
      deps.ui.write(`  ${index + 1}. ${subtask.title}`);
    });
  }
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
        providerName: ctx.providerName,
        task,
      },
      {
        maxConcurrency: concurrency,
        ...(staged ? { waves } : {}),
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

  // AO5 — PROACTIVE resume: if any lane failed, Excalibur OFFERS to retry just
  // those lanes (no command). One-shot (noResumeOffer guards the retry run). Runs
  // after the successful lanes are applied below, so good work ships first.
  const failedSubtasks = lanes.filter((s) => result.lanes.some((l) => l.id === s.id && l.failed));
  const offerRetryFailed = async (): Promise<void> => {
    if (
      failedSubtasks.length === 0 ||
      options.noResumeOffer === true ||
      options.yes === true ||
      !deps.ui.isInteractive()
    ) {
      return;
    }
    const retry = await deps.ui.confirm(deps.t('swarm.retryFailed', { n: failedSubtasks.length }), {
      defaultYes: true,
    });
    if (retry) {
      await runSwarmFlow(deps, repoRoot, task, ctx, {
        ...options,
        subtasks: failedSubtasks,
        noResumeOffer: true,
      });
    }
  };

  if (result.mergedDiff.trim().length === 0) {
    deps.ui.info(deps.t('swarm.noChanges'));
    await offerRetryFailed();
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
  } catch (error) {
    deps.ui.error(
      deps.t('swarm.applyFailed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return;
  }
  // AO4b — VERIFIED FAN-IN: run the configured test command on the MERGED tree
  // (opt-in via config.orchestration.verifyMerge). Two individually-green lanes
  // can break IN COMBINATION; a red run REVERTS the merge instead of shipping a
  // broken integration. The deterministic worktree merge + ground-truth gate is
  // the differentiator CC/OpenCode structurally lack.
  if (ctx.config.orchestration?.verifyMerge === true) {
    const revertMerge = (): void => {
      try {
        applyPatch(repoRoot, result.mergedDiff, { reverse: true });
      } catch {
        /* best-effort revert — keep going to report the failure */
      }
    };
    // 1. Ground truth: the configured test command on the merged tree.
    const verify = runConfiguredCommandCheck(repoRoot, ctx.config.commands?.test, options.signal);
    if (verify !== undefined) {
      deps.ui.info(deps.t('swarm.verifying'));
      const verdict = await verify();
      if (!verdict.passed) {
        revertMerge();
        deps.ui.error(deps.t('swarm.verifyFailed', { detail: verdict.detail }));
        return;
      }
      deps.ui.success(deps.t('swarm.verified', { detail: verdict.detail }));
    }
    // 2. AO4f: a proportional adversarial Verification-Mesh over the merged diff.
    //    A surviving HIGH issue blocks the merge (revert), same as a red test.
    if (await runMergeMesh(deps, ctx, result.mergedDiff)) {
      revertMerge();
      deps.ui.error(deps.t('swarm.mesh-blocked'));
      return;
    }
  }
  deps.ui.success(deps.t('swarm.applied'));
  await offerRetryFailed();
}
