/**
 * Interrupt triage (project §"interruptions") — when the user types WHILE Excalibur
 * is working or is mid-question, classify what they mean so the shell can react
 * intelligently instead of CC's "answer-the-new-thing-and-forget-the-old".
 *
 * A sibling of the turn intent router (same injected-model, no-keyword/regex,
 * multilingual contract — a French/German/… interruption triages the same), kept
 * in its OWN file because it answers a DIFFERENT question (what to do with an
 * interruption, not what shape a fresh turn is). Pure + model-injected, so the
 * routing logic is unit-testable with a fake.
 */

/**
 * What an interruption MEANS, relative to the in-flight work:
 * - `steer`  — adjust/redirect the CURRENT work ("also handle the error case").
 * - `quick`  — a quick question answerable WITHOUT stopping ("how long left?").
 * - `new`    — a DIFFERENT, separate request ("now add dark mode").
 * - `stop`   — cancel the current work ("stop", "wait, that's wrong").
 * - `answer` — this IS the answer to what Excalibur just asked (only possible when
 *   Excalibur is awaiting an answer).
 */
export type InterruptClass = 'steer' | 'quick' | 'new' | 'stop' | 'answer';

export const INTERRUPT_CLASSES: readonly InterruptClass[] = [
  'steer',
  'quick',
  'new',
  'stop',
  'answer',
];

export type InterruptConfidence = 'high' | 'medium' | 'low';
const INTERRUPT_CONFIDENCES: readonly InterruptConfidence[] = ['high', 'medium', 'low'];

export interface InterruptDecision {
  cls: InterruptClass;
  confidence: InterruptConfidence;
}

/** Context the triage needs about the in-flight work. */
export interface InterruptContext {
  /** A one-line description of what Excalibur is currently doing. */
  currentWork: string;
  /** Excalibur is BLOCKED asking the user something (approval/question) right now. */
  awaitingAnswer: boolean;
  /** The exact question/approval being awaited (when `awaitingAnswer`). */
  pendingQuestion?: string;
}

/**
 * Injected classifier call: takes the prompt, returns the model's raw answer. The
 * REPL backs this with the FAST/cheap model; core stays SDK-free + testable.
 */
export type InterruptModel = (prompt: string, signal?: AbortSignal) => Promise<string>;

/** Builds the language-agnostic triage prompt (the MODEL handles any language). */
export function buildInterruptPrompt(input: string, ctx: InterruptContext): string {
  return [
    'Excalibur is an AI coding agent that is CURRENTLY BUSY. The user just typed something while it',
    'works. Classify what the user MEANS so the agent reacts well (never lose the current work):',
    '',
    `What Excalibur is doing now: ${ctx.currentWork}`,
    ...(ctx.awaitingAnswer
      ? [`Excalibur just ASKED the user (and is waiting): ${ctx.pendingQuestion ?? '(a question)'}`]
      : []),
    '',
    'Categories:',
    '- steer: adjust or redirect the CURRENT work (a correction, an added requirement, a different approach to the SAME task).',
    '- quick: a quick question that can be answered WITHOUT stopping the current work ("how long?", "what are you doing?", a small lookup).',
    '- new: a DIFFERENT, separate request — new work unrelated to the current task.',
    '- stop: cancel/abort the current work ("stop", "wait, that’s wrong", "cancel").',
    ctx.awaitingAnswer
      ? '- answer: this IS the answer to the question Excalibur just asked.'
      : '- answer: NOT POSSIBLE right now (Excalibur is not waiting on an answer) — never choose it.',
    '',
    'Answer with EXACTLY two words: the category then your confidence (high, medium, or low).',
    'Example: "steer high" or "new medium".',
    '',
    `The user typed: ${input}`,
  ].join('\n');
}

/** Extracts the class word; unrecognized → a safe default for the context. */
export function parseInterruptClass(output: string, ctx: InterruptContext): InterruptClass {
  const tokens = output.toLowerCase().match(/[a-z]+/g) ?? [];
  const found = tokens.find((t) => (INTERRUPT_CLASSES as readonly string[]).includes(t));
  if (found === undefined) {
    // Unsure: if Excalibur was waiting on an answer, assume this is it; otherwise
    // treat as NEW work (conservative — preserves the current task, handles the
    // input separately rather than derailing the current work by folding it in).
    return ctx.awaitingAnswer ? 'answer' : 'new';
  }
  // `answer` is only valid while awaiting one; otherwise fall back to new.
  if (found === 'answer' && !ctx.awaitingAnswer) {
    return 'new';
  }
  return found as InterruptClass;
}

/** Extracts the confidence word; unrecognized → `medium`. */
export function parseInterruptConfidence(output: string): InterruptConfidence {
  const tokens = output.toLowerCase().match(/[a-z]+/g) ?? [];
  const found = tokens.find((t) => (INTERRUPT_CONFIDENCES as readonly string[]).includes(t));
  return (found as InterruptConfidence | undefined) ?? 'medium';
}

/** Parses a model answer into a full {@link InterruptDecision}. */
export function parseInterruptDecision(output: string, ctx: InterruptContext): InterruptDecision {
  return { cls: parseInterruptClass(output, ctx), confidence: parseInterruptConfidence(output) };
}

/**
 * Classifies an interruption via the injected LLM (multi-language). Falls back to
 * a safe default ({@link parseInterruptClass}) on empty input or any model error,
 * so the shell never blocks on triage.
 */
export async function classifyInterrupt(
  input: string,
  ctx: InterruptContext,
  model: InterruptModel,
  signal?: AbortSignal,
): Promise<InterruptDecision> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { cls: ctx.awaitingAnswer ? 'answer' : 'new', confidence: 'low' };
  }
  try {
    const out = await model(buildInterruptPrompt(trimmed, ctx), signal);
    return parseInterruptDecision(out, ctx);
  } catch {
    return { cls: ctx.awaitingAnswer ? 'answer' : 'new', confidence: 'low' };
  }
}

// --- Independence check (INT-3) ---------------------------------------------
//
// For a NEW interruption: would it be INDEPENDENT of the current work (different
// files/subsystems → safe to run in PARALLEL), or would it OVERLAP/conflict (same
// area → must pause the current and switch)? The chosen default behaviour:
// independent → parallel background thread, conflicting → pause + switch.

export interface IndependenceContext {
  /** A one-line description of the current work. */
  currentWork: string;
  /** Files the current work has already read/written (from its run events). */
  touchedPaths: readonly string[];
}

export interface IndependenceVerdict {
  independent: boolean;
  reason: string;
}

/** Builds the independence-judgement prompt. */
export function buildIndependencePrompt(newRequest: string, ctx: IndependenceContext): string {
  const files = ctx.touchedPaths.length > 0 ? ctx.touchedPaths.join(', ') : '(none touched yet)';
  return [
    'An AI coding agent is busy with one task and a NEW, separate request just arrived. Decide',
    'whether the NEW request can run IN PARALLEL with the current work, or would COLLIDE with it',
    '(touch the same files/subsystem) and must wait.',
    '',
    `Current work: ${ctx.currentWork}`,
    `Files the current work is touching: ${files}`,
    `New request: ${newRequest}`,
    '',
    'Answer with INDEPENDENT (different files/area, safe to run at the same time) or OVERLAP',
    '(same files/area, must run after) as the FIRST word, then a one-sentence reason.',
  ].join('\n');
}

/** Parses the verdict; defaults to NOT independent (pause is the safe default). */
export function parseIndependence(output: string): IndependenceVerdict {
  const lower = output.toLowerCase();
  const reason =
    output
      .trim()
      .replace(/^(independent|overlap|conflict)[:.\s-]*/i, '')
      .split('\n')[0]
      ?.slice(0, 200) || 'assessed';
  // Check the collision signals FIRST so "not independent" never reads as independent.
  const conflicting = /overlap|conflict|not\s+independent|same\s+(file|area|module)|depends/.test(
    lower,
  );
  const independent = !conflicting && /independent|parallel|separate|unrelated/.test(lower);
  return { independent, reason };
}

/**
 * Judges whether a new request is independent of the current work (→ parallel) or
 * overlaps (→ pause). Conservative: any model error/empty → NOT independent (pause),
 * since running two agents over the same files is the dangerous case. Never throws.
 */
export async function assessIndependence(
  newRequest: string,
  ctx: IndependenceContext,
  model: InterruptModel,
  signal?: AbortSignal,
): Promise<IndependenceVerdict> {
  if (newRequest.trim().length === 0) {
    return { independent: false, reason: 'no request' };
  }
  try {
    const out = await model(buildIndependencePrompt(newRequest, ctx), signal);
    return parseIndependence(out);
  } catch {
    return { independent: false, reason: 'could not assess — pausing is the safe default' };
  }
}

// --- Routing + acknowledgment (INT-4) ---------------------------------------
//
// Turns a triage decision (+ independence) into the ACTION the shell takes and the
// INSTANT acknowledgment the user sees BEFORE it acts. The execution of each action
// (fold via supervisor.reassess, parallel background thread, pause+switch, re-ask…)
// is wired in the CLI where the live run handles exist; this is the pure decision.

export type InterruptAction =
  /** steer → fold into the current work. */
  | 'fold'
  /** quick question → answer now, work keeps running. */
  | 'answer_inline'
  /** new + independent → run as a parallel background thread. */
  | 'parallel'
  /** new + conflicting → pause the current work, do the new, then resume. */
  | 'pause_switch'
  /** stop → abort the current work. */
  | 'abort'
  /** the input IS the answer to the pending question → feed it. */
  | 'feed_answer';

export interface InterruptPlan {
  action: InterruptAction;
  /**
   * After handling, RE-ASK the pending question Excalibur was waiting on (the
   * input was a side-question/steer/new while it was awaiting an answer — never
   * lose the original prompt).
   */
  reaskAfter: boolean;
  /** The instant, human acknowledgment to show the user before acting. */
  ack: string;
}

/**
 * Reduce a current-work description to a SHORT, single-line label safe to show in an
 * ack. The work text may be a long, multi-line INTERNAL prompt (e.g. the self-heal
 * "Diagnose the ROOT CAUSE… Original task… Failing checks…"): take only the first
 * non-empty line, collapse whitespace, and clamp to ~64 chars so the ack never leaks
 * a wall of internal text into the rail (RUN-FIX-20).
 */
function summarizeWork(work: string): string {
  const firstLine =
    String(work)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  const collapsed = firstLine.replace(/\s+/g, ' ').trim();
  return collapsed.length > 64 ? `${collapsed.slice(0, 63)}…` : collapsed;
}

/** The instant acknowledgment — names the interpretation so the user can correct it. */
export function buildInterruptAck(
  action: InterruptAction,
  decision: InterruptDecision,
  ctx: InterruptContext,
  reaskAfter: boolean,
): string {
  // NEVER interpolate the raw current-work text: during a self-heal it is a long,
  // multi-line INTERNAL prompt ("Diagnose the ROOT CAUSE… Original task… Failing
  // checks…") that would leak verbatim into the rail. Clamp to a short single line so
  // the ack stays a clean one-liner no matter what the caller passed (RUN-FIX-20).
  const work = summarizeWork(ctx.currentWork);
  const resume = reaskAfter ? ' Then I’ll go back to the question.' : '';
  const base = ((): string => {
    switch (action) {
      case 'fold':
        return `↻ Folding that into the current work (${work}).`;
      case 'answer_inline':
        return `↳ Quick answer — ${work} keeps running.`;
      case 'parallel':
        return `▶ Running that in parallel (independent of ${work}); the current work continues.`;
      case 'pause_switch':
        return `⏸ Pausing ${work} and switching to this; I’ll resume it after.`;
      case 'abort':
        return `⏹ Stopping ${work}.`;
      case 'feed_answer':
        return `✓ Got it.`;
    }
  })();
  // Per the ambiguity choice (act on best guess, let the user correct): on a
  // non-high-confidence read, invite a one-word correction.
  const hint =
    decision.confidence !== 'high' && action !== 'feed_answer'
      ? ' (say "no, it’s separate" / "that’s for the current task" if I read it wrong)'
      : '';
  return `${base}${resume}${hint}`;
}

/**
 * Plans the shell's reaction to an interruption: the {@link InterruptAction}, whether
 * to re-ask a pending question afterwards, and the acknowledgment. Pure + total.
 * `independence` is only consulted for a `new` request (null → treated as a pause).
 */
export function planInterrupt(
  decision: InterruptDecision,
  independence: IndependenceVerdict | null,
  ctx: InterruptContext,
): InterruptPlan {
  // Re-ask the pending question when the input was something OTHER than its answer
  // or an outright stop, while Excalibur was awaiting an answer.
  const reaskAfter = ctx.awaitingAnswer && decision.cls !== 'answer' && decision.cls !== 'stop';
  let action: InterruptAction;
  switch (decision.cls) {
    case 'answer':
      action = 'feed_answer';
      break;
    case 'stop':
      action = 'abort';
      break;
    case 'steer':
      action = 'fold';
      break;
    case 'quick':
      action = 'answer_inline';
      break;
    case 'new':
      action = independence?.independent === true ? 'parallel' : 'pause_switch';
      break;
  }
  return { action, reaskAfter, ack: buildInterruptAck(action, decision, ctx, reaskAfter) };
}

// --- Composition: the full triage → route (INT-1 wiring) ---------------------

export interface InterruptDecisionContext extends InterruptContext {
  /** Files the current work has touched — only consulted for a `new` request. */
  touchedPaths?: readonly string[];
}

export interface InterruptOutcome {
  /** The triage decision (class + confidence). */
  decision: InterruptDecision;
  /** The independence verdict — only computed for a `new` request, else null. */
  independence: IndependenceVerdict | null;
  /** The routing plan (action + re-ask + ack). */
  plan: InterruptPlan;
}

/**
 * The end-to-end interrupt brain: classify the typed input, judge independence
 * (only when it is NEW work — the only case where parallel-vs-pause matters),
 * and route it to an action with an instant acknowledgment. ONE call the shell
 * makes per submitted interrupt; the executor then acts on `plan.action`.
 *
 * Total + safe: every step has a conservative fallback (never throws), so a
 * model hiccup degrades to "treat as new, pause" rather than losing the run.
 */
export async function decideInterrupt(
  input: string,
  ctx: InterruptDecisionContext,
  model: InterruptModel,
  signal?: AbortSignal,
): Promise<InterruptOutcome> {
  const decision = await classifyInterrupt(input, ctx, model, signal);
  const independence =
    decision.cls === 'new'
      ? await assessIndependence(
          input,
          { currentWork: ctx.currentWork, touchedPaths: ctx.touchedPaths ?? [] },
          model,
          signal,
        )
      : null;
  const plan = planInterrupt(decision, independence, ctx);
  return { decision, independence, plan };
}
