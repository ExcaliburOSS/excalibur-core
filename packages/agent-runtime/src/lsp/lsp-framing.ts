/**
 * LSP message framing — `Content-Length: <N>\r\n\r\n<body>` over RAW BYTES.
 *
 * Unlike the MCP stdio transport (newline-delimited JSON over a utf8-decoded
 * string stream), LSP frames each JSON-RPC message with a byte-count header, so
 * the decoder MUST operate on Buffers: decoding the stream to a string first
 * would make the `Content-Length` byte count wrong the moment a multi-byte
 * UTF-8 character straddles a chunk boundary.
 */

/** The `\r\n\r\n` that separates a frame's header block from its JSON body. */
const HEADER_SEP = Buffer.from('\r\n\r\n', 'ascii');
const CONTENT_LENGTH_RE = /content-length:\s*(\d+)/i;
/** Reject an absurd Content-Length so a corrupt/hostile header can't OOM us. */
const MAX_CONTENT_LENGTH = 32 * 1024 * 1024;

/** Encodes a JSON-RPC message as a `Content-Length`-framed Buffer. */
export function encodeMessage(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

/** Thrown when the byte stream is unframable (corrupt header / oversized / bad JSON). */
export class LspFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LspFramingError';
  }
}

/**
 * Accumulates raw stdout bytes and yields each fully-framed JSON message via
 * {@link drain}. Tolerant of a header split across chunks, a body split across
 * chunks, and multiple messages in one chunk. Throws {@link LspFramingError} on
 * an unparseable header, an oversized Content-Length, or a body that is not
 * valid JSON — all of which mean the stream is corrupt (the transport treats it
 * as a terminal close).
 */
export class MessageBuffer {
  private buffer: Buffer = Buffer.alloc(0);

  append(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  *drain(): IterableIterator<unknown> {
    for (;;) {
      const sepIndex = this.buffer.indexOf(HEADER_SEP);
      if (sepIndex === -1) {
        return; // the header has not fully arrived yet
      }
      const header = this.buffer.subarray(0, sepIndex).toString('ascii');
      const match = CONTENT_LENGTH_RE.exec(header);
      if (match === null) {
        throw new LspFramingError(
          `LSP frame header has no Content-Length: ${JSON.stringify(header)}`,
        );
      }
      const length = Number.parseInt(match[1] ?? '', 10);
      if (!Number.isFinite(length) || length < 0 || length > MAX_CONTENT_LENGTH) {
        throw new LspFramingError(`LSP frame Content-Length out of range: ${match[1]}`);
      }
      const bodyStart = sepIndex + HEADER_SEP.length;
      if (this.buffer.length < bodyStart + length) {
        return; // the body has not fully arrived yet
      }
      const body = this.buffer.subarray(bodyStart, bodyStart + length);
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        yield JSON.parse(body.toString('utf8'));
      } catch (error) {
        throw new LspFramingError(
          `LSP frame body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
