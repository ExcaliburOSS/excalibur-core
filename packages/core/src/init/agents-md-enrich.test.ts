import { describe, expect, it } from 'vitest';
import type { ChatOutput, GatewayChatInput } from '@excalibur/model-gateway';
import { fakeAnalysis } from '../test-utils';
import { enrichAgentsMd, type AgentsMdChat } from './init-plan';

/** A fake chat returning scripted content and recording every input. */
function fakeChat(content: string, captured: GatewayChatInput[] = []): AgentsMdChat {
  return {
    chat: (input: GatewayChatInput): Promise<ChatOutput> => {
      captured.push(input);
      return Promise.resolve({
        content,
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1 },
        costCents: 0,
        finishReason: 'stop',
      });
    },
  };
}

describe('enrichAgentsMd', () => {
  it('splices model prose in while KEEPING the deterministic factual sections', async () => {
    const content = JSON.stringify({
      conventions: ['Use the repository pattern in src/db', 'Co-locate tests with modules'],
      architecture: 'The app is layered: HTTP routes → services → repositories over Postgres.',
    });
    const md = await enrichAgentsMd(fakeAnalysis(), { chat: fakeChat(content) });
    // Model-contributed prose:
    expect(md).toContain('## Architecture');
    expect(md).toContain('HTTP routes → services → repositories');
    expect(md).toContain('- Use the repository pattern in src/db');
    expect(md).toContain('- Co-locate tests with modules');
    // Deterministic factual sections survive untouched:
    expect(md).toContain('# fake-repo');
    expect(md).toContain('## Stack');
    expect(md).toContain('## Commands');
    expect(md).toContain('pnpm test');
    expect(md).toContain('## Sensitive areas');
    // Deterministic core conventions are still present too.
    expect(md).toContain('Update the relevant documentation');
  });

  it('strips a leading bullet marker the model may add to a convention', async () => {
    const md = await enrichAgentsMd(fakeAnalysis(), {
      chat: fakeChat('{"conventions":["- already bulleted"],"architecture":""}'),
    });
    expect(md).toContain('- already bulleted');
    expect(md).not.toContain('- - already bulleted');
  });

  it('throws when the model returns no parseable JSON (caller falls back to deterministic)', async () => {
    await expect(enrichAgentsMd(fakeAnalysis(), { chat: fakeChat('sorry, no json here') })).rejects.toThrow();
  });

  it('throws when the model yields empty conventions AND empty architecture', async () => {
    await expect(
      enrichAgentsMd(fakeAnalysis(), { chat: fakeChat('{"conventions":[],"architecture":""}') }),
    ).rejects.toThrow();
  });

  it('redacts secrets from the enriched prose', async () => {
    const secret = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const md = await enrichAgentsMd(fakeAnalysis(), {
      chat: fakeChat(
        JSON.stringify({ conventions: [`never hardcode ${secret}`], architecture: `uses ${secret} for auth` }),
      ),
    });
    expect(md).not.toContain(secret);
    expect(md).toContain('[REDACTED]');
  });

  it('routes to the given provider and sends the deterministic draft as context', async () => {
    const captured: GatewayChatInput[] = [];
    await enrichAgentsMd(fakeAnalysis(), {
      chat: fakeChat('{"conventions":["x"],"architecture":"y"}', captured),
      provider: 'main',
      locale: 'es',
    });
    expect(captured[0]!.provider).toBe('main');
    expect(captured[0]!.metadata).toMatchObject({ kind: 'agents-md-enrich' });
    const userMsg = captured[0]!.messages.find((m) => m.role === 'user');
    // Compact FACTS are the context (not the full markdown doc, which would
    // prime the model to continue markdown instead of emitting JSON).
    expect(userMsg?.content).toContain('Repository facts:');
    expect(userMsg?.content).toContain('languages:');
    expect(userMsg?.content).not.toContain('## Stack');
    const sysMsg = captured[0]!.messages.find((m) => m.role === 'system');
    expect(sysMsg?.content).toContain('Spanish');
  });
});
