import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@excalibur/model-gateway';
import type { AsyncSummarizer } from './model-summarizer';
import { compactMessages } from './in-turn-compactor';

const sys = (c: string): ChatMessage => ({ role: 'system', content: c });
const usr = (c: string): ChatMessage => ({ role: 'user', content: c });
const asst = (c: string, toolIds: string[] = []): ChatMessage => ({
  role: 'assistant',
  content: c,
  ...(toolIds.length > 0
    ? { toolCalls: toolIds.map((id) => ({ id, name: 'tool', arguments: {} })) }
    : {}),
});
const tool = (id: string, c: string): ChatMessage => ({ role: 'tool', toolCallId: id, content: c });

/** The provider invariant: every `tool` result follows its `assistant` tool-call. */
function pairingValid(messages: ReadonlyArray<ChatMessage>): boolean {
  let open = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant') {
      open = new Set((m.toolCalls ?? []).map((c) => c.id));
    } else if (m.role === 'tool') {
      if (m.toolCallId === undefined || !open.has(m.toolCallId)) {
        return false; // orphaned tool result
      }
    } else {
      open = new Set(); // user/system reset the open tool-call scope
    }
  }
  return true;
}

const fakeSummarizer = (summary: string): AsyncSummarizer => {
  return async () => ({
    summary,
    structuredSummary: {
      objective: '',
      decisions: [],
      filesTouched: [],
      pending: [],
      condensed: { entries: 0, userTurns: 0, assistantTurns: 0 },
    },
  });
};

const BUDGET = { contextWindow: 1000, reserveTokens: 100, keepRecentTokens: 12 }; // budget = 900 tok

describe('compactMessages (in-turn)', () => {
  it('returns null when already within budget', async () => {
    const messages = [sys('agent'), usr('hi'), asst('hello')];
    expect(
      await compactMessages(messages, {
        contextWindow: 128000,
        reserveTokens: 16384,
        keepRecentTokens: 20000,
      }),
    ).toBeNull();
  });

  it('Tier 1: truncates an old tool output, preserves pairing + ids, no model call', async () => {
    const messages = [
      sys('You are an agent.'),
      asst('Let me read the file.', ['t1']),
      tool('t1', 'X'.repeat(8000)), // huge OLD tool output (dominates the window)
      asst('Now editing based on results.'),
      usr('keep going'),
      asst('Made an edit.'),
    ];
    // No summarizer → Tier 1 only must bring it under budget by pruning the tool.
    const out = await compactMessages(messages, BUDGET);
    expect(out).not.toBeNull();
    const result = out as ChatMessage[];
    expect(pairingValid(result)).toBe(true);
    const toolMsg = result.find((m) => m.role === 'tool');
    expect(toolMsg?.toolCallId).toBe('t1'); // id preserved
    expect(toolMsg!.content.length).toBeLessThan(8000); // truncated
    expect(toolMsg!.content).toContain('elided');
    const tokens = result.reduce((s, m) => s + Math.ceil(m.content.length / 4), 0);
    expect(tokens).toBeLessThanOrEqual(900);
  });

  it('Tier 2: summarizes the middle when Tier 1 is not enough, keeping a valid head+tail', async () => {
    const big = 'long assistant reasoning step '.repeat(20); // ~600 chars each → no tool to prune
    const messages: ChatMessage[] = [
      sys('You are an agent.'),
      ...Array.from({ length: 12 }, (_, i) => asst(`${big} #${i}`)),
      usr('continue'),
      asst('latest state'),
    ];
    const out = await compactMessages(messages, {
      ...BUDGET,
      summarize: fakeSummarizer('MIDDLE SUMMARY'),
    });
    expect(out).not.toBeNull();
    const result = out as ChatMessage[];
    expect(pairingValid(result)).toBe(true);
    expect(result[0]?.role).toBe('system'); // head preserved
    expect(result.some((m) => m.role === 'system' && m.content.includes('MIDDLE SUMMARY'))).toBe(
      true,
    );
    expect(result.length).toBeLessThan(messages.length); // middle collapsed
    // The recent tail survives verbatim.
    expect(result.at(-1)?.content).toBe('latest state');
  });

  it('Tier 2: never orphans a tool result at the tail boundary', async () => {
    // A tool exchange straddles where the naive cut would fall; safeCut must move
    // the tail start off the `tool` message so pairing stays valid.
    const filler = 'reasoning '.repeat(40);
    const messages: ChatMessage[] = [
      sys('agent'),
      ...Array.from({ length: 8 }, (_, i) => asst(`${filler} #${i}`)),
      asst('calling a tool', ['tZ']),
      tool('tZ', 'Y'.repeat(200)),
      asst('done with tool'),
      usr('next'),
    ];
    const out = await compactMessages(messages, { ...BUDGET, summarize: fakeSummarizer('S') });
    const result = (out ?? messages) as ChatMessage[];
    expect(pairingValid(result)).toBe(true);
    // The first non-head message is the summary (system) or a user/assistant — never a bare tool.
    const afterHead = result.filter((m) => m.role !== 'system');
    expect(afterHead[0]?.role).not.toBe('tool');
  });

  it('falls back to the Tier 1 result when the summarizer throws', async () => {
    const throwing: AsyncSummarizer = async () => {
      throw new Error('model down');
    };
    const messages = [
      sys('agent'),
      asst('read', ['t1']),
      tool('t1', 'Z'.repeat(8000)),
      usr('go'),
      asst('ok'),
    ];
    const out = await compactMessages(messages, { ...BUDGET, summarize: throwing });
    expect(out).not.toBeNull();
    expect(pairingValid(out as ChatMessage[])).toBe(true);
    expect((out as ChatMessage[]).find((m) => m.role === 'tool')!.content).toContain('elided');
  });
});
