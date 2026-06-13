import { describe, expect, it } from 'vitest';
import { parseNdjson, parseSSE, type SSEMessage } from './sse';

async function* fromLines(lines: string[]): AsyncIterable<string> {
  for (const line of lines) {
    yield line;
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of iterable) {
    out.push(value);
  }
  return out;
}

describe('parseSSE', () => {
  it('groups data fields into messages on blank-line boundaries', async () => {
    const messages = await collect(
      parseSSE(
        fromLines([
          'event: a',
          'data: {"x":1}',
          '',
          'data: {"y":2}',
          '',
        ]),
      ),
    );
    expect(messages).toEqual<SSEMessage[]>([
      { event: 'a', data: '{"x":1}' },
      { data: '{"y":2}' },
    ]);
  });

  it('accumulates multi-line data fields joined by newline', async () => {
    const [message] = await collect(
      parseSSE(fromLines(['data: line1', 'data: line2', ''])),
    );
    expect(message?.data).toBe('line1\nline2');
  });

  it('ignores comment lines starting with a colon', async () => {
    const messages = await collect(
      parseSSE(fromLines([': keep-alive heartbeat', 'data: hello', ''])),
    );
    expect(messages).toEqual<SSEMessage[]>([{ data: 'hello' }]);
  });

  it('flushes a trailing message without a final blank line', async () => {
    const messages = await collect(parseSSE(fromLines(['data: tail'])));
    expect(messages).toEqual<SSEMessage[]>([{ data: 'tail' }]);
  });

  it('strips exactly one leading space after the colon', async () => {
    const [message] = await collect(parseSSE(fromLines(['data:  two-spaces', ''])));
    // One framing space removed, the second is preserved as content.
    expect(message?.data).toBe(' two-spaces');
  });
});

describe('parseNdjson', () => {
  it('parses each non-empty line as JSON', async () => {
    const values = await collect(
      parseNdjson(fromLines(['{"a":1}', '', '  ', '{"b":2}'])),
    );
    expect(values).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('throws on a malformed JSON line', async () => {
    await expect(collect(parseNdjson(fromLines(['{not json}'])))).rejects.toThrow();
  });
});
