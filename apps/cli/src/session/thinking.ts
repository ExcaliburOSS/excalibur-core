import pc from 'picocolors';
import { Spinner, isTtyStream } from '../lib/spinner';

/** The narrow slice of the UI the thinking indicator needs. */
export interface ThinkingDeps {
  ui: { isOutputTty(): boolean };
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Wraps an await with an always-visible "thinking" indicator so the user is
 * NEVER left watching a silent cursor during a model call or a read-only scan.
 *
 * On a real TTY it shows a breathing braille glyph plus a friendly status phrase
 * that ROTATES through `phrases` (e.g. "Understanding what you are asking…" →
 * "Thinking about how to approach this…"), owning the current line and erasing
 * it when the work finishes. On a non-TTY (pipe/CI/tests) it is a silent
 * passthrough so logs and snapshots stay clean.
 */
export async function withThinking<T>(
  deps: ThinkingDeps,
  phrases: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const out = process.stdout;
  if (phrases.length === 0 || !deps.ui.isOutputTty() || !isTtyStream(out)) {
    return fn();
  }
  const spinner = new Spinner(out, { enabled: true });
  let tick = 0;
  const ROTATE = 16; // ~1.4s per phrase at the spinner's ~90ms tick
  spinner.start(() => {
    const phrase = phrases[Math.floor(tick / ROTATE) % phrases.length] ?? '';
    tick += 1;
    return pc.dim(`${phrase}…`);
  });
  try {
    return await fn();
  } finally {
    spinner.stop();
  }
}

/** Friendly, rotating phrases for the "understanding the request" wait. */
export const understandingPhrases = (t: Translate): string[] => [
  t('thinking.understand.a'),
  t('thinking.understand.b'),
  t('thinking.understand.c'),
];

/** Friendly, rotating phrases for the "scoping / shaping a plan" wait. */
export const planningPhrases = (t: Translate): string[] => [
  t('thinking.plan.a'),
  t('thinking.plan.b'),
  t('thinking.plan.c'),
];

/** Friendly, rotating phrases for the "breaking work into steps" wait. */
export const decomposePhrases = (t: Translate): string[] => [
  t('thinking.decompose.a'),
  t('thinking.decompose.b'),
];
