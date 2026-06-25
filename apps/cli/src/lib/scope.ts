import {
  askStructured,
  buildRepoContextSources,
  buildScopeExplorePrompt,
  parseScopeFragment,
  scopeMapToMarkdown,
  scopeTask,
  SCOPE_FRAGMENT_SCHEMA,
  type IntentModel,
  type ScopeAngle,
  type ScopeComplexity,
  type ScopeFragment,
  type ScopeMap,
} from '@excalibur/core';
import type { CliDeps } from '../deps';
import { loadGatewayContext, requireConfiguredModel, type GatewayContext } from './context';

/**
 * AO9-2 — the wired backing for the AO9-1 scope engine: builds the injected
 * `classify` (decompose + synthesize) and `explore` (per-angle) from the REAL
 * model gateway + deterministic repo retrieval, then runs `scopeTask`.
 *
 * Read-only by construction: `explore` grounds each angle with
 * `buildRepoContextSources` (lexical retrieval — it CANNOT mutate the tree, the
 * same path `ask` uses) and a schema-forced `askStructured` call. There is no
 * write/patch/run tool anywhere in the loop, so the safety floor is structural,
 * not policy.
 *
 * `computeScope` returns the ScopeMap (rendering is the caller's job) so the
 * proactive path (AO9-3) and the dashboard (AO9-4) reuse the exact same wiring.
 */

/** Generous JSON ceiling for decompose/synthesize. kimi-k2.7-code is a reasoning
 * model that spends a tiny budget entirely on thinking → empty content (the
 * AO8-4 lesson). Synthesis in particular folds N detailed fragments, so it needs
 * real headroom to think AND emit the JSON — 2200 (verified vs real Kimi: at 1200
 * the synthesis summary came back empty). Decompose/complexity stay well under it. */
const SCOPE_MODEL_MAXTOKENS = 2200;
/** Files retrieved per explorer angle (read-only grounding). */
const EXPLORE_MAX_FILES = 6;

export interface ScopeComputeOptions {
  /** Skip the auto-dimensioning probe and force the angle ceiling. */
  angles?: number;
  /** Skip the complexity probe (drives the angle ceiling). */
  complexity?: ScopeComplexity;
  /** Progress sink (decompose → explore×N → synthesize). */
  onProgress?: (phase: 'decompose' | 'explore' | 'synthesize', subsystem?: string) => void;
  signal?: AbortSignal;
}

export interface ScopeFlowOptions extends ScopeComputeOptions {
  json?: boolean;
}

/** One-word complexity probe — multilingual (the model reads the task in any
 * language and answers with one of three fixed English tokens we then map). */
function complexityPrompt(task: string): string {
  return [
    'Rate how broad this coding task is for an EXISTING codebase, as ONE word only:',
    '"small" (a localized change, 1-2 areas), "medium" (several areas), or "large"',
    '(cross-cutting / many subsystems). Answer with ONLY that single word, no prose.',
    '',
    `Task: ${task}`,
  ].join('\n');
}

/** Maps the probe's answer to a complexity. Defaults to 'medium' on anything
 * unexpected (parsing a constrained 3-token enum answer, not user intent). */
export async function estimateComplexity(
  classify: IntentModel,
  task: string,
  signal?: AbortSignal,
): Promise<ScopeComplexity> {
  try {
    const answer = (await classify(complexityPrompt(task), signal)).toLowerCase();
    if (answer.includes('large')) return 'large';
    if (answer.includes('small')) return 'small';
    return 'medium';
  } catch {
    return 'medium';
  }
}

/**
 * Runs the scope engine over a repo with the real gateway. Returns the ScopeMap
 * (or null when there is nothing to scope / the model can't decompose). Never
 * throws on a per-angle failure — a partial map still ships (AO9-1 contract).
 */
export async function computeScope(
  repoRoot: string,
  task: string,
  gw: GatewayContext,
  options: ScopeComputeOptions = {},
): Promise<ScopeMap | null> {
  const provider = gw.providerName;

  const classify: IntentModel = async (prompt, signal) => {
    const out = await gw.gateway.chat({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: SCOPE_MODEL_MAXTOKENS,
      provider,
      ...(signal !== undefined ? { signal } : {}),
      metadata: { kind: 'scope' },
    });
    return out.content;
  };

  const explore = async (
    t: string,
    angle: ScopeAngle,
    signal?: AbortSignal,
  ): Promise<ScopeFragment | null> => {
    // READ-ONLY grounding: pull the files most relevant to this angle into the
    // prompt. Retrieval cannot write/patch/run — the safety floor is structural.
    const sources = await buildRepoContextSources({
      repoRoot,
      query: `${angle.subsystem} ${angle.question}`,
      maxFiles: EXPLORE_MAX_FILES,
    });
    const systemContext = sources.map((s) => s.content).join('\n\n');
    const res = await askStructured(gw.gateway, {
      question: buildScopeExplorePrompt(t, angle),
      schema: SCOPE_FRAGMENT_SCHEMA,
      ...(systemContext.length > 0 ? { systemContext } : {}),
      provider,
      ...(signal !== undefined ? { signal } : {}),
    });
    // askStructured already prefers the schema-valid JSON; re-validate/coerce
    // through the engine's parser so a loose-but-useful reply is still kept.
    const raw = res.value !== undefined ? JSON.stringify(res.value) : res.raw;
    return parseScopeFragment(raw, angle.subsystem);
  };

  const complexity =
    options.complexity ?? (await estimateComplexity(classify, task, options.signal));

  return scopeTask(task, {
    classify,
    explore,
    complexity,
    ...(options.angles !== undefined ? { maxAngles: options.angles } : {}),
    ...(options.onProgress !== undefined
      ? { onProgress: (p) => options.onProgress?.(p.phase, p.subsystem) }
      : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
}

/**
 * `excalibur scope "<task>"` flow: scope the task read-only over the repo and
 * render the ScopeMap on a TTY (markdown) or as `--json`. Refuses when no
 * provider is configured (the mock is never a silent fallback).
 */
export async function runScopeFlow(
  deps: CliDeps,
  task: string,
  options: ScopeFlowOptions = {},
): Promise<void> {
  const repoRoot = deps.cwd();
  const gw = loadGatewayContext(repoRoot);
  requireConfiguredModel(gw, deps.t);

  // In --json mode stdout must be PURE JSON — suppress all human chrome.
  if (options.json !== true) deps.ui.info(deps.t('scope.starting', { task }));
  const map = await computeScope(repoRoot, task, gw, {
    ...(options.angles !== undefined ? { angles: options.angles } : {}),
    ...(options.complexity !== undefined ? { complexity: options.complexity } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    onProgress: (phase, subsystem) => {
      if (options.json === true) return; // keep JSON output clean
      if (phase === 'decompose') deps.ui.info(deps.t('scope.decomposed'));
      else if (phase === 'explore')
        deps.ui.info(deps.t('scope.explored', { subsystem: subsystem ?? '' }));
      else deps.ui.info(deps.t('scope.synthesizing'));
    },
  });

  if (map === null) {
    if (options.json === true) deps.ui.json(null);
    else deps.ui.warn(deps.t('scope.empty'));
    return;
  }

  if (options.json === true) {
    deps.ui.json(map);
    return;
  }

  deps.ui.write();
  deps.ui.write(scopeMapToMarkdown(map));
  deps.ui.info(
    deps.t('scope.summary', {
      subsystems: String(map.subsystems.length),
      risks: String(map.risks.length),
      questions: String(map.openQuestions.length),
    }),
  );
}
