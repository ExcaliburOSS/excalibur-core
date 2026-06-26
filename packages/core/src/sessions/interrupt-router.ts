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
