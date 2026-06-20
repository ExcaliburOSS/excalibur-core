import { describe, expect, it } from 'vitest';
import type { ChatInput, ChatOutput, ModelGateway } from '@excalibur/model-gateway';
import { makeCitedSource } from './citations';
import { verifyClaim } from './claim-verifier';

type ChatRunner = Pick<ModelGateway, 'chat'>;

/** A gateway whose every vote replies with the given verdict word. */
function votingGateway(replies: string[]): ChatRunner {
  let i = 0;
  return {
    chat: async (_input: ChatInput): Promise<ChatOutput> =>
      ({
        content: replies[Math.min(i++, replies.length - 1)] as string,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'fake',
        costCents: null,
        finishReason: 'stop',
      }) as ChatOutput,
  };
}

const sources = [makeCitedSource('https://a.test/', 'A', 'the sky is blue', 't')];

describe('verifyClaim', () => {
  it('verifies a claim when a majority votes SUPPORTED', async () => {
    const v = await verifyClaim(
      'sky is blue',
      sources,
      votingGateway(['SUPPORTED', 'SUPPORTED', 'UNSUPPORTED']),
      3,
    );
    expect(v.verified).toBe(true);
    expect(v.votes).toBe(2);
    expect(v.total).toBe(3);
  });

  it('rejects a claim when a majority votes UNSUPPORTED', async () => {
    const v = await verifyClaim(
      'sky is green',
      sources,
      votingGateway(['UNSUPPORTED', 'UNSUPPORTED', 'SUPPORTED']),
      3,
    );
    expect(v.verified).toBe(false);
    expect(v.votes).toBe(1);
  });

  it('parses tolerantly (SUPPORTED only counts when UNSUPPORTED is absent)', async () => {
    const v = await verifyClaim(
      'x',
      sources,
      votingGateway(['Verdict: SUPPORTED', 'UNSUPPORTED', 'SUPPORTED.']),
      3,
    );
    expect(v.votes).toBe(2);
  });
});
