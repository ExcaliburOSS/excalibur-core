/**
 * Streaming wire-format parsers shared by the real provider adapters.
 *
 * `parseSSE` implements the Server-Sent Events grouping the Anthropic and
 * OpenAI-compatible streams use; `parseNdjson` implements the newline-delimited
 * JSON the Ollama stream uses. Both consume the decoded line stream produced by
 * the transport (`TransportResponse.lines()`).
 */

/** A single SSE message: its optional `event:` name and accumulated `data:`. */
export interface SSEMessage {
  event?: string;
  data: string;
}

/**
 * Groups decoded lines into SSE messages on blank-line boundaries.
 *
 * Per the SSE spec: `data:` fields accumulate (joined by `\n`), `event:` names
 * the message, lines beginning with `:` are comments and ignored, and a blank
 * line dispatches the accumulated message. A trailing message with no final
 * blank line is still flushed at end-of-stream.
 */
export async function* parseSSE(
  lines: AsyncIterable<string>,
): AsyncIterable<SSEMessage> {
  let event: string | undefined;
  const dataLines: string[] = [];
  let hasData = false;

  const flush = (): SSEMessage | null => {
    if (!hasData && event === undefined) {
      return null;
    }
    const message: SSEMessage = { data: dataLines.join('\n') };
    if (event !== undefined) {
      message.event = event;
    }
    event = undefined;
    dataLines.length = 0;
    hasData = false;
    return message;
  };

  for await (const line of lines) {
    if (line === '') {
      const message = flush();
      if (message !== null) {
        yield message;
      }
      continue;
    }
    if (line.startsWith(':')) {
      // Comment / heartbeat line — ignore.
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // A single leading space after the colon is part of the SSE framing.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'data') {
      dataLines.push(value);
      hasData = true;
    } else if (field === 'event') {
      event = value;
    }
    // Other fields (id, retry) are not needed by these adapters.
  }

  const tail = flush();
  if (tail !== null) {
    yield tail;
  }
}

/** Parses each non-empty line as a JSON value (newline-delimited JSON). */
export async function* parseNdjson(
  lines: AsyncIterable<string>,
): AsyncIterable<unknown> {
  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    yield JSON.parse(trimmed);
  }
}
