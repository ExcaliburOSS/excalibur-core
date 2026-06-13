import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../cost/cost';
import type { ChatInput, ChatMessage } from '../types';
import { MOCK_RESPONSE_KINDS, MockProvider, type MockResponseKind } from './mock-provider';

const provider = new MockProvider({ simulateLatency: false });

function input(content: string, kind?: MockResponseKind): ChatInput {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are Excalibur, a careful engineering copilot.' },
    { role: 'user', content },
  ];
  return kind === undefined ? { messages } : { messages, metadata: { kind } };
}

/**
 * Minimal unified-diff syntax checker: validates ---/+++ pairing, hunk
 * headers, line prefixes and that hunk line counts match the header.
 */
function assertValidUnifiedDiff(diff: string): { added: number; removed: number } {
  const lines = diff.split('\n');
  let added = 0;
  let removed = 0;
  let index = 0;
  expect(lines.length).toBeGreaterThan(0);
  // The mock now emits new-file diffs: `--- /dev/null` / `+++ b/<path>`.
  while (index < lines.length) {
    expect(lines[index]).toMatch(/^--- (?:a\/.+|\/dev\/null)$/);
    expect(lines[index + 1]).toMatch(/^\+\+\+ b\/.+$/);
    index += 2;
    const header = lines[index];
    const match = header?.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
    expect(match, `expected hunk header, got: ${header}`).toBeTruthy();
    if (!match) throw new Error('unreachable');
    const oldCount = Number(match[2]);
    const newCount = Number(match[4]);
    index += 1;
    let oldSeen = 0;
    let newSeen = 0;
    while (index < lines.length && !lines[index]?.startsWith('--- ')) {
      const line = lines[index] ?? '';
      expect(line).toMatch(/^[ +-]/);
      if (line.startsWith('+')) {
        added += 1;
        newSeen += 1;
      } else if (line.startsWith('-')) {
        removed += 1;
        oldSeen += 1;
      } else {
        oldSeen += 1;
        newSeen += 1;
      }
      index += 1;
    }
    expect(oldSeen).toBe(oldCount);
    expect(newSeen).toBe(newCount);
  }
  return { added, removed };
}

function extractDiff(content: string): string {
  const match = content.match(/```diff\n([\s\S]*?)\n```/);
  expect(match, 'patch output must contain a ```diff fenced block').toBeTruthy();
  return match?.[1] ?? '';
}

describe('MockProvider.chat determinism', () => {
  it('returns byte-identical output for identical input', async () => {
    const ask = input('Why does the escrow release run twice?');
    const first = await provider.chat(ask);
    const second = await provider.chat(ask);
    expect(second.content).toBe(first.content);
    expect(second.usage).toEqual(first.usage);
    expect(second.model).toBe(first.model);
  });

  it('is deterministic across separate provider instances', async () => {
    const other = new MockProvider({ simulateLatency: false });
    const ask = input('Summarize the auth module.', 'summary');
    expect((await other.chat(ask)).content).toBe((await provider.chat(ask)).content);
  });

  it('changes output when the messages change', async () => {
    const first = await provider.chat(input('Question one about billing.'));
    const second = await provider.chat(input('Question two about invoices.'));
    expect(first.content).not.toBe(second.content);
  });
});

describe('MockProvider templates', () => {
  it.each(MOCK_RESPONSE_KINDS)('the %s template starts with the mock banner', async (kind) => {
    const output = await provider.chat(input('Improve error handling in the payment flow.', kind));
    expect(output.content.startsWith('> Mock provider (M1)')).toBe(true);
  });

  it.each([
    ['review', '## Code review'],
    ['explain', '## Explanation'],
    ['ask', '## Answer'],
    ['plan', '## Plan'],
    ['patch', '## Proposed patch'],
    ['summary', '## Summary'],
    ['alternatives', '## Alternatives'],
    ['test_generation', '## Generated tests'],
  ] as Array<[MockResponseKind, string]>)(
    'the %s template has its own heading',
    async (kind, heading) => {
      const output = await provider.chat(input('Harden the webhook handler.', kind));
      expect(output.content).toContain(heading);
    },
  );

  it('defaults to the ask template when metadata.kind is missing or unknown', async () => {
    const noMeta = await provider.chat({ messages: input('What does this service do?').messages });
    expect(noMeta.content).toContain('## Answer');
    const unknownKind = await provider.chat({
      messages: input('What does this service do?').messages,
      metadata: { kind: 'haiku' },
    });
    expect(unknownKind.content).toContain('## Answer');
  });

  it('quotes a truncated portion of the user content', async () => {
    const longTask = `Fix the duplicate release bug. ${'Context detail. '.repeat(50)}`;
    const output = await provider.chat(input(longTask, 'plan'));
    expect(output.content).toContain('> Fix the duplicate release bug.');
    expect(output.content).toContain('…');
    expect(output.content).not.toContain(longTask.trim());
  });

  it('never claims to be a real model and reports usage via estimateTokens', async () => {
    const ask = input('Explain the retry logic.', 'explain');
    const output = await provider.chat(ask);
    const inputText = ask.messages.map((m) => m.content).join('\n');
    expect(output.usage.inputTokens).toBe(estimateTokens(inputText));
    expect(output.usage.outputTokens).toBe(estimateTokens(output.content));
    expect(output.costCents).toBeNull();
    expect(output.finishReason).toBe('stop');
  });

  it('uses input.model, then the constructor model, then mock-model', async () => {
    const named = new MockProvider({ simulateLatency: false, model: 'excalibur-mock' });
    expect((await named.chat(input('hi'))).model).toBe('excalibur-mock');
    expect((await named.chat({ ...input('hi'), model: 'override' })).model).toBe('override');
    expect((await provider.chat(input('hi'))).model).toBe('mock-model');
  });
});

describe('MockProvider patch kind', () => {
  it('targets file paths found in the prompt', async () => {
    const output = await provider.chat(
      input('Fix the double release in src/escrow/escrow.service.ts please.', 'patch'),
    );
    const diff = extractDiff(output.content);
    // New-file diff (creates the path), so the source header is /dev/null.
    expect(diff).toContain('--- /dev/null');
    expect(diff).toContain('+++ b/src/escrow/escrow.service.ts');
  });

  it('falls back to src/example.service.ts when no path is mentioned', async () => {
    const output = await provider.chat(input('Fix the duplicate billing run.', 'patch'));
    const diff = extractDiff(output.content);
    expect(diff).toContain('+++ b/src/example.service.ts');
  });

  it('emits a syntactically valid unified diff with 3-10 changed lines per file', async () => {
    const output = await provider.chat(
      input('Guard the handler in src/payments/payment.service.ts against retries.', 'patch'),
    );
    const diff = extractDiff(output.content);
    const { added, removed } = assertValidUnifiedDiff(diff);
    const changed = added + removed;
    expect(changed).toBeGreaterThanOrEqual(3);
    expect(changed).toBeLessThanOrEqual(10);
  });

  it('covers multiple distinct paths from the prompt', async () => {
    const output = await provider.chat(
      input(
        'Apply the fix to src/a/alpha.service.ts and src/b/beta.controller.ts (mentioned twice: src/a/alpha.service.ts).',
        'patch',
      ),
    );
    const diff = extractDiff(output.content);
    assertValidUnifiedDiff(diff);
    expect(diff).toContain('+++ b/src/a/alpha.service.ts');
    expect(diff).toContain('+++ b/src/b/beta.controller.ts');
    // Deduplicated: alpha appears once as a file header.
    expect(diff.match(/\+\+\+ b\/src\/a\/alpha\.service\.ts/g)?.length).toBe(1);
  });

  it('does not truncate .tsx paths to .ts', async () => {
    const output = await provider.chat(input('Update src/app/page.tsx accordingly.', 'patch'));
    const diff = extractDiff(output.content);
    expect(diff).toContain('+++ b/src/app/page.tsx');
  });
});

describe('MockProvider.stream', () => {
  it('streams the exact chat content and terminates with done', async () => {
    const ask = input('Review the migration plan.', 'review');
    const chatOutput = await provider.chat(ask);
    const deltas = [];
    for await (const delta of provider.stream(ask)) {
      deltas.push(delta);
    }
    const last = deltas[deltas.length - 1];
    expect(last).toEqual({ content: '', done: true });
    expect(deltas.slice(0, -1).every((delta) => !delta.done)).toBe(true);
    const streamed = deltas.map((delta) => delta.content).join('');
    expect(streamed).toBe(chatOutput.content);
  });
});

describe('MockProvider latency', () => {
  it('derives a fake latency of 30-80 ms from the input by default', async () => {
    const timed = new MockProvider();
    const start = performance.now();
    await timed.chat(input('latency check'));
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(25); // small scheduler tolerance
    expect(elapsed).toBeLessThan(500);
  });
});
