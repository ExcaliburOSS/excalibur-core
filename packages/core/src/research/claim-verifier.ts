import { type ModelGateway } from '@excalibur/model-gateway';
import type { CitedSource } from './citations';

/**
 * Adversarial multi-vote claim verification (F7). Each candidate claim is judged
 * by N INDEPENDENT, blind fact-checker votes against the fetched sources; a claim
 * is "verified" only with a majority of SUPPORTED votes. This is the no-groupthink
 * design (mirrors the verification mesh): independent verifiers, tolerant parse,
 * majority fold. The gateway is INJECTED so it is unit-tested with a fake chat.
 */

type ChatRunner = Pick<ModelGateway, 'chat'>;

export interface ClaimVerdict {
  claim: string;
  verified: boolean;
  /** SUPPORTED votes. */
  votes: number;
  /** Total ballots cast. */
  total: number;
}

/** Caps the per-source context handed to a verifier (keeps the vote cheap). */
const PER_SOURCE_CHARS = 1500;

function sourceContext(sources: ReadonlyArray<CitedSource>): string {
  return sources
    .map((s, i) => `[${i + 1}] ${s.title} (${s.url})\n${s.markdown.slice(0, PER_SOURCE_CHARS)}`)
    .join('\n\n');
}

async function oneVote(
  claim: string,
  context: string,
  gateway: ChatRunner,
  index: number,
  opts: { model?: string; provider?: string; signal?: AbortSignal },
): Promise<boolean> {
  const out = await gateway.chat({
    messages: [
      {
        role: 'system',
        content:
          'You are a strict, independent fact-checker. Given SOURCES and a CLAIM, decide whether the SOURCES directly support the claim. Answer with ONLY one word: SUPPORTED or UNSUPPORTED. Choose SUPPORTED only when the sources clearly back the claim; otherwise UNSUPPORTED.',
      },
      {
        role: 'user',
        content: `SOURCES:\n${context}\n\nCLAIM: ${claim}\n\nVerdict (SUPPORTED or UNSUPPORTED):`,
      },
    ],
    metadata: { kind: 'research_verify', vote: index },
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  const text = out.content.toUpperCase();
  // Tolerant parse: SUPPORTED wins only when it appears and UNSUPPORTED does not.
  return text.includes('SUPPORTED') && !text.includes('UNSUPPORTED');
}

/** Verifies one claim with `votes` independent ballots; verified ⇔ a majority SUPPORTED. */
export async function verifyClaim(
  claim: string,
  sources: ReadonlyArray<CitedSource>,
  gateway: ChatRunner,
  votes = 3,
  opts: { model?: string; provider?: string; signal?: AbortSignal } = {},
): Promise<ClaimVerdict> {
  const context = sourceContext(sources);
  const ballots = await Promise.all(
    Array.from({ length: Math.max(1, votes) }, (_, i) => oneVote(claim, context, gateway, i, opts)),
  );
  const supported = ballots.filter(Boolean).length;
  return {
    claim,
    verified: supported * 2 > ballots.length,
    votes: supported,
    total: ballots.length,
  };
}
