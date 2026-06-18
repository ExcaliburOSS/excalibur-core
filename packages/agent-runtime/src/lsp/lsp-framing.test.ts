import { describe, expect, it } from 'vitest';
import { encodeMessage, LspFramingError, MessageBuffer } from './lsp-framing';

/** Collects every message a buffer yields after appending one chunk. */
function drainAll(buf: MessageBuffer, chunk: Buffer): unknown[] {
  buf.append(chunk);
  return [...buf.drain()];
}

describe('encodeMessage', () => {
  it('frames a payload as Content-Length + CRLFCRLF + utf8 JSON body', () => {
    const out = encodeMessage({ jsonrpc: '2.0', id: 1, method: 'x' });
    const text = out.toString('utf8');
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x' });
    expect(text).toBe(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });

  it('counts BYTES, not characters, for a multi-byte body', () => {
    const out = encodeMessage({ s: '€' }); // € is 3 bytes in utf8
    const body = JSON.stringify({ s: '€' });
    expect(out.toString('utf8')).toContain(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`);
    expect(Buffer.byteLength(body)).toBeGreaterThan(body.length); // proves byte≠char
  });
});

describe('MessageBuffer.drain', () => {
  it('decodes a single framed message', () => {
    const msgs = drainAll(new MessageBuffer(), encodeMessage({ id: 1, result: 'ok' }));
    expect(msgs).toEqual([{ id: 1, result: 'ok' }]);
  });

  it('decodes multiple messages in one chunk', () => {
    const buf = new MessageBuffer();
    const chunk = Buffer.concat([encodeMessage({ id: 1 }), encodeMessage({ id: 2 }), encodeMessage({ id: 3 })]);
    expect(drainAll(buf, chunk)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it('waits for a header split across chunks', () => {
    const buf = new MessageBuffer();
    const full = encodeMessage({ id: 7 });
    expect(drainAll(buf, full.subarray(0, 8))).toEqual([]); // mid-header
    buf.append(full.subarray(8));
    expect([...buf.drain()]).toEqual([{ id: 7 }]);
  });

  it('waits for a body split across chunks', () => {
    const buf = new MessageBuffer();
    const full = encodeMessage({ id: 9, value: 'hello world' });
    const sep = full.indexOf(Buffer.from('\r\n\r\n')) + 4;
    expect(drainAll(buf, full.subarray(0, sep + 3))).toEqual([]); // header + partial body
    buf.append(full.subarray(sep + 3));
    expect([...buf.drain()]).toEqual([{ id: 9, value: 'hello world' }]);
  });

  it('reassembles a body split INSIDE a multi-byte UTF-8 char (the byte-stream invariant)', () => {
    const buf = new MessageBuffer();
    const full = encodeMessage({ s: '€'.repeat(3) }); // each € is 3 bytes
    // Cut at an odd byte offset deep in the body so a € is severed mid-codepoint.
    const cut = full.length - 4;
    expect(drainAll(buf, full.subarray(0, cut))).toEqual([]);
    buf.append(full.subarray(cut));
    expect([...buf.drain()]).toEqual([{ s: '€€€' }]);
  });

  it('throws on a header with no Content-Length', () => {
    const buf = new MessageBuffer();
    buf.append(Buffer.from('X-Foo: 1\r\n\r\n{}', 'utf8'));
    expect(() => [...buf.drain()]).toThrowError(LspFramingError);
  });

  it('throws on an oversized Content-Length (anti-OOM)', () => {
    const buf = new MessageBuffer();
    buf.append(Buffer.from('Content-Length: 999999999\r\n\r\n', 'ascii'));
    expect(() => [...buf.drain()]).toThrowError(/out of range/);
  });

  it('throws LspFramingError (not a raw SyntaxError) on a non-JSON body', () => {
    const buf = new MessageBuffer();
    const bad = 'not json';
    buf.append(Buffer.from(`Content-Length: ${bad.length}\r\n\r\n${bad}`, 'ascii'));
    expect(() => [...buf.drain()]).toThrowError(LspFramingError);
  });
});
