import { cpus } from 'node:os';
import { NativeAgentAdapter } from '@excalibur/agent-runtime';
import { applyPatch, chooseConcurrency, runSwarm } from '@excalibur/core';
import type { GatewayChatInput, ModelGateway } from '@excalibur/model-gateway';
import type { ExcaliburConfig, ExcaliburEvent } from '@excalibur/shared';
import type { CliDeps } from '../deps';
import { runConfiguredCommandCheck } from './verify-command';

/**
 * AO5 — best-of-N exploration (`/explore`). Fans the SAME task to N candidate
 * agents in isolated git worktrees (diversified by APPROACH seed, never by
 * temperature — reasoning models reject it), then SELECTS one winner and applies
 * ONLY that candidate (never a union-merge of competing same-file diffs). This is
 * the parallel, real best-of-N — distinct from the existing single-agent
 * `run --explore` (`explore-alternatives`) workflow.
 *
 * Selection: a model tournament judge picks the winner from the candidate diffs;
 * when a test command is configured the applied winner is then ground-truth
 * gated (reuse of the AO4b verified-apply), reverting a red winner.
 */

/** Fixed candidate count — kept small + deterministic (mirrors EXPLORE_CANDIDATES). */
const EXPLORE_CANDIDATES = 3;

/** Distinct approach seeds so the N candidates diverge by STRATEGY, not by sampling. */
const APPROACH_SEEDS = [
  'Favor the simplest, most readable solution.',
  'Favor robustness and edge-case handling.',
  'Favor performance and a minimal-footprint change.',
  'Favor reusing existing abstractions in the codebase.',
];

export interface ExploreLaneSummary {
  costCents: number | null;
  toolCalls: number;
}

export interface ExploreFlowContext {
  gateway: ModelGateway;
  providerName: string;
  config: ExcaliburConfig;
}

export interface ExploreFlowOptions {
  /** Hard ceiling on candidates (default EXPLORE_CANDIDATES). */
  candidates?: number;
  /** Apply the winner without prompting. */
  yes?: boolean;
  signal?: AbortSignal;
}

/** One scored candidate the selector chooses between. */
export interface ExploreCandidate {
  id: string;
  approach: string;
  diff: string;
  failed: boolean;
}

/**
 * Picks the winning candidate index from a model judge's reply (pure). The judge
 * answers with the 1-based index of the best candidate; anything unparseable or
 * out of range falls back to the first non-empty candidate. Never returns a
 * failed/empty candidate when a usable one exists.
 */
export function selectWinner(
  candidates: ReadonlyArray<ExploreCandidate>,
  judgeReply: string,
): number {
  const usable = candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !c.failed && c.diff.trim().length > 0);
  if (usable.length === 0) return -1;
  const match = judgeReply.match(/\d+/);
  if (match !== null) {
    const oneBased = Number.parseInt(match[0], 10);
    const idx = oneBased - 1;
    if (usable.some(({ i }) => i === idx)) return idx;
  }
  return usable[0]!.i;
}

/** Asks the model which candidate diff best solves the task; returns its raw reply. */
async function judgeCandidates(
  gateway: ModelGateway,
  provider: string,
  task: string,
  candidates: ReadonlyArray<ExploreCandidate>,
  signal: AbortSignal | undefined,
): Promise<string> {
  const system =
    'You are choosing the BEST of several candidate implementations of the SAME task. ' +
    'Weigh correctness first, then simplicity and fit with the codebase. Reply with ONLY the ' +
    '1-based NUMBER of the best candidate (e.g. "2"). No prose.';
  const body = candidates
    .map(
      (c, i) =>
        `### Candidate ${i + 1} (${c.approach})\n${c.diff.slice(0, 8000) || '(no changes)'}`,
    )
    .join('\n\n');
  const input: GatewayChatInput = {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Task:\n${task}\n\n${body}\n\nWhich candidate number is best?` },
    ],
    maxTokens: 12,
    metadata: { kind: 'explore-judge' },
    provider,
    ...(signal !== undefined ? { signal } : {}),
  };
  const out = await gateway.chat(input);
  return out.content;
}

/**
 * Runs the full best-of-N flow: fan N diversified candidates out across isolated
 * worktrees, select the winner (model judge), apply only the winner (gated), then
 * — when a test command is configured — ground-truth gate the applied winner,
 * reverting it on a red run.
 */
export async function runExploreFlow(
  deps: CliDeps,
  repoRoot: string,
  task: string,
  ctx: ExploreFlowContext,
  options: ExploreFlowOptions = {},
): Promise<void> {
  const n = Math.max(2, Math.min(options.candidates ?? EXPLORE_CANDIDATES, APPROACH_SEEDS.length));
  const lanes = Array.from({ length: n }, (_, i) => ({
    id: `cand-${i + 1}`,
    instruction: `${task}\n\nAPPROACH ${i + 1}: ${APPROACH_SEEDS[i]}`,
  }));
  const concurrency = chooseConcurrency({ laneCount: n, cpuCount: cpus().length });

  deps.ui.write();
  deps.ui.heading(deps.t('explore.heading', { n }));
  lanes.forEach((l, i) => deps.ui.write(`  ${i + 1}. ${APPROACH_SEEDS[i]}`));
  deps.ui.write();
  const go =
    options.yes === true ||
    (await deps.ui.confirm(deps.t('explore.confirm', { n }), { defaultYes: true }));
  if (!go) {
    deps.ui.info(deps.t('explore.cancelled'));
    return;
  }

  deps.ui.info(deps.t('explore.running'));
  const result = await runSwarm<ExploreLaneSummary>(
    repoRoot,
    lanes,
    async ({ lane, worktreePath }) => {
      const adapter = new NativeAgentAdapter();
      let costCents: number | null = null;
      let toolCalls = 0;
      let lastError: string | null = null;
      for await (const event of adapter.run({
        runId: `explore_${lane.id}`,
        sessionId: `explore_${lane.id}`,
        workdir: worktreePath,
        prompt: lane.instruction,
        role: 'implementer',
        config: ctx.config,
        gateway: ctx.gateway,
        confirm: () => Promise.resolve(true),
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
      if (lastError !== null && toolCalls === 0) throw new Error(lastError);
      return { costCents, toolCalls };
    },
    {
      maxConcurrency: concurrency,
      // AO5-5 — a distinct namespace so a concurrent explore + swarm in one repo
      // never collide on `excalibur/swarm-d0-*` worktrees/branches.
      idPrefix: 'explore',
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
  );

  const candidates: ExploreCandidate[] = result.lanes.map((l, i) => ({
    id: l.id,
    approach: APPROACH_SEEDS[i] ?? l.id,
    diff: l.diff,
    failed: l.failed,
  }));
  const usable = candidates.filter((c) => !c.failed && c.diff.trim().length > 0);
  if (usable.length === 0) {
    deps.ui.info(deps.t('explore.noCandidates'));
    return;
  }

  // SELECT the winner (model tournament judge; fail-open to the first usable one).
  let winnerIdx: number;
  try {
    const reply = await judgeCandidates(
      ctx.gateway,
      ctx.providerName,
      task,
      candidates,
      options.signal,
    );
    winnerIdx = selectWinner(candidates, reply);
  } catch {
    winnerIdx = candidates.indexOf(usable[0]!);
  }
  if (winnerIdx < 0) {
    deps.ui.info(deps.t('explore.noCandidates'));
    return;
  }
  const winner = candidates[winnerIdx]!;
  deps.ui.success(deps.t('explore.winner', { n: winnerIdx + 1, approach: winner.approach }));
  deps.ui.write();
  deps.ui.write(winner.diff);

  const apply =
    options.yes === true ||
    (await deps.ui.confirm(deps.t('explore.confirmApply'), { defaultYes: false }));
  if (!apply) {
    deps.ui.info(deps.t('explore.leftUnapplied'));
    return;
  }
  try {
    applyPatch(repoRoot, winner.diff);
  } catch (error) {
    deps.ui.error(
      deps.t('explore.applyFailed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return;
  }
  // Ground-truth gate the applied winner (objective): a red test reverts it.
  const verify = runConfiguredCommandCheck(repoRoot, ctx.config.commands?.test, options.signal);
  if (verify !== undefined) {
    deps.ui.info(deps.t('explore.verifying'));
    const verdict = await verify();
    if (!verdict.passed) {
      try {
        applyPatch(repoRoot, winner.diff, { reverse: true });
      } catch {
        /* best-effort revert */
      }
      deps.ui.error(deps.t('explore.verifyFailed', { detail: verdict.detail }));
      return;
    }
    deps.ui.success(deps.t('explore.verified', { detail: verdict.detail }));
  }
  deps.ui.success(deps.t('explore.applied'));
}
