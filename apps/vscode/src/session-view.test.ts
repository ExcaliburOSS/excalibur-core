import { describe, expect, it } from 'vitest';
import { sessionViewHtml, toViewMessage } from './session-view';

describe('toViewMessage', () => {
  it('maps agent message chunks (and drops empty ones)', () => {
    expect(
      toViewMessage({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' },
      }),
    ).toEqual({
      kind: 'message',
      text: 'hi',
    });
    expect(
      toViewMessage({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } }),
    ).toBeNull();
  });

  it('maps tool calls + completions + plans', () => {
    expect(toViewMessage({ sessionUpdate: 'tool_call', title: 'read_file' })).toEqual({
      kind: 'tool',
      label: 'read_file',
    });
    expect(
      toViewMessage({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' }),
    ).toEqual({
      kind: 'tool-done',
      label: 't1',
      ok: false,
    });
    expect(
      toViewMessage({
        sessionUpdate: 'plan',
        entries: [{ content: 'step', status: 'in_progress' }],
      }),
    ).toEqual({ kind: 'plan', entries: [{ text: 'step', status: 'in_progress' }] });
  });

  it('ignores unknown update kinds', () => {
    expect(toViewMessage({ sessionUpdate: 'something_else' })).toBeNull();
  });
});

describe('sessionViewHtml', () => {
  it('embeds the nonce in the CSP + script and renders with textContent (no innerHTML)', () => {
    const html = sessionViewHtml('NONCE123');
    expect(html).toContain("script-src 'nonce-NONCE123'");
    expect(html).toContain('<script nonce="NONCE123">');
    expect(html).toContain('textContent');
    expect(html).not.toContain('innerHTML');
  });
});
