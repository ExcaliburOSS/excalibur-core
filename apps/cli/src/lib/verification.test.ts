import type { ChatInput, ChatOutput } from '@excalibur/model-gateway';
import { describe, expect, it } from 'vitest';
import { runVerificationMesh } from './verification';

/** A gateway whose JSON verdict is chosen by the request's `metadata.kind` (mesh-<lens>). */
function gateway(byLens: Record<string, string>): { chat: (i: ChatInput) => Promise<ChatOutput> } {
  return {
    chat: (input: ChatInput): Promise<ChatOutput> => {
      const kind = String((input.metadata as { kind?: string } | undefined)?.kind ?? '');
      const lens = kind.replace(/^mesh-/, '');
      return Promise.resolve({
        content: byLens[lens] ?? '{"clean":true,"issues":[]}',
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1 },
        costCents: 0,
        finishReason: 'stop',
      });
    },
  };
}

describe('runVerificationMesh', () => {
  it('runs each lens in isolation, aggregates, and BLOCKS on a high issue from ANY lens', async () => {
    const res = await runVerificationMesh({
      diff: '--- a/x.ts\n+++ b/x.ts\n+const k = "AKIA..."',
      lenses: ['correctness', 'security'],
      gateway: gateway({
        correctness: '{"clean":true,"issues":[]}',
        security:
          '{"clean":false,"issues":[{"severity":"high","file":"x.ts","problem":"hardcoded secret","fix":"read from env"}]}',
      }),
    });
    expect([...res.lensesRun].sort()).toEqual(['correctness', 'security']);
    expect(res.blocked).toBe(true);
    expect(res.issues[0]?.severity).toBe('high');
    expect(res.issues[0]?.lens).toBe('security');
    expect(res.summary).toMatch(/BLOCKING/);
  });

  it('tolerates fenced JSON + surrounding prose; medium issues do not block', async () => {
    const res = await runVerificationMesh({
      diff: 'd',
      lenses: ['correctness'],
      gateway: gateway({
        correctness:
          'Here is my verdict:\n```json\n{"clean":false,"issues":[{"severity":"medium","problem":"off-by-one"}]}\n```',
      }),
    });
    expect(res.blocked).toBe(false);
    expect(res.issues).toHaveLength(1);
  });

  it('treats UNPARSEABLE verifier output as clean (never fabricates a block)', async () => {
    const res = await runVerificationMesh({
      diff: 'd',
      lenses: ['correctness'],
      gateway: gateway({ correctness: 'Looks fine to me, no JSON here.' }),
    });
    expect(res.blocked).toBe(false);
    expect(res.issues).toEqual([]);
  });

  it('no lenses → not blocked, nothing run', async () => {
    const res = await runVerificationMesh({ diff: 'd', lenses: [], gateway: gateway({}) });
    expect(res.blocked).toBe(false);
    expect(res.lensesRun).toEqual([]);
  });
});
