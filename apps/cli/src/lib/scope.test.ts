import { describe, expect, it, vi } from 'vitest';
import type { GatewayContext } from './context';
import { autoScopeForPlanning, computeScope, estimateComplexity } from './scope';

/**
 * A content-dispatching fake gateway: it answers each scope-engine call (the
 * complexity probe, decompose, per-angle explore, synthesize) by inspecting the
 * user message, so the test is order-independent (explorers run in parallel).
 */
function fakeGateway(): {
  chat: (input: {
    messages: Array<{ role: string; content: string }>;
    maxTokens?: number;
  }) => Promise<{ content: string }>;
} {
  return {
    chat: async (input) => {
      const user = input.messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .join('\n');
      if (user.includes('Rate how broad')) return { content: 'medium' };
      if (user.includes('exploration angles')) {
        return {
          content:
            '{"angles":[{"subsystem":"auth","question":"how is login done?"},{"subsystem":"db","question":"what store?"}]}',
        };
      }
      if (user.includes('READ-ONLY code explorer')) {
        const subsystem = /subsystem: "([^"]+)"/.exec(user)?.[1] ?? 'unknown';
        return {
          content: JSON.stringify({
            subsystem,
            files: [`${subsystem}.ts`],
            whatExists: `${subsystem} exists`,
            whatsMissing: `${subsystem} gap`,
            risks: [],
          }),
        };
      }
      if (user.includes('Synthesize these')) {
        return {
          content:
            '{"summary":"auth + db","risks":["migration"],"openQuestions":["which provider?"]}',
        };
      }
      return { content: '{}' };
    },
  };
}

function gwContext(): GatewayContext {
  return { gateway: fakeGateway(), providerName: 'kimi' } as unknown as GatewayContext;
}

describe('estimateComplexity (multilingual one-word probe)', () => {
  it('maps the probe answer to a complexity, defaulting to medium', async () => {
    expect(await estimateComplexity(async () => 'large', 'x')).toBe('large');
    expect(await estimateComplexity(async () => 'SMALL change', 'x')).toBe('small');
    expect(await estimateComplexity(async () => 'medium', 'x')).toBe('medium');
    expect(await estimateComplexity(async () => 'who knows', 'x')).toBe('medium');
  });

  it('defaults to medium when the probe throws', async () => {
    expect(
      await estimateComplexity(async () => {
        throw new Error('probe down');
      }, 'x'),
    ).toBe('medium');
  });
});

describe('computeScope (AO9-2 wired backing, read-only)', () => {
  // A path with no repo → buildRepoContextSources returns [] (best-effort, never
  // throws); the explorers still run, grounded only on the prompt.
  const NO_REPO = '/nonexistent-scope-test-dir';

  it('decomposes → explores each angle → synthesizes a ScopeMap', async () => {
    const phases: string[] = [];
    const map = await computeScope(NO_REPO, 'add MFA', gwContext(), {
      onProgress: (phase) => phases.push(phase),
    });
    expect(map).not.toBeNull();
    expect(map!.summary).toBe('auth + db');
    expect(map!.subsystems.map((s) => s.subsystem).sort()).toEqual(['auth', 'db']);
    expect(map!.risks).toEqual(['migration']);
    expect(map!.openQuestions).toEqual(['which provider?']);
    expect(phases[0]).toBe('decompose');
    expect(phases.filter((p) => p === 'explore')).toHaveLength(2);
    expect(phases[phases.length - 1]).toBe('synthesize');
  });

  it('honours an explicit complexity (skips the probe) and an angle cap', async () => {
    const gw = gwContext();
    const spy = vi.spyOn(gw.gateway as unknown as { chat: () => unknown }, 'chat');
    const map = await computeScope(NO_REPO, 'add MFA', gw, { complexity: 'small', angles: 1 });
    expect(map).not.toBeNull();
    expect(map!.subsystems).toHaveLength(1); // capped to 1 even though 2 were proposed
    // No "Rate how broad" probe call was made (complexity was supplied).
    const probed = spy.mock.calls.some((c) => JSON.stringify(c).includes('Rate how broad'));
    expect(probed).toBe(false);
  });

  it('skips the complexity probe when --angles is forced (no wasted round-trip)', async () => {
    const gw = gwContext();
    const spy = vi.spyOn(gw.gateway as unknown as { chat: () => unknown }, 'chat');
    await computeScope(NO_REPO, 'add MFA', gw, { angles: 1 }); // angles but no complexity
    const probed = spy.mock.calls.some((c) => JSON.stringify(c).includes('Rate how broad'));
    expect(probed).toBe(false);
  });

  it('threads the scope budget (2200) into the wired explore call (not askStructured 1500)', async () => {
    const gw = gwContext();
    const spy = vi.spyOn(gw.gateway as unknown as { chat: (input: unknown) => unknown }, 'chat');
    await computeScope(NO_REPO, 'add MFA', gw, { complexity: 'small' });
    // Find the explore call (its user message carries the explorer prompt) and
    // assert it ran at the declared 2200 ceiling, not askStructured's 1500 default.
    type ChatInput = { messages: Array<{ content: string }>; maxTokens?: number };
    const exploreCall = spy.mock.calls.find((c) =>
      (c[0] as ChatInput).messages.some((m) => m.content.includes('READ-ONLY code explorer')),
    );
    expect(exploreCall).toBeDefined();
    expect((exploreCall![0] as ChatInput).maxTokens).toBe(2200);
  });

  it('redacts a secret in the task before any model call (parity with intent/plan-shape)', async () => {
    const gw = gwContext();
    const spy = vi.spyOn(gw.gateway as unknown as { chat: (input: unknown) => unknown }, 'chat');
    const secret = 'sk-live-ABCDEFGHIJKLMNOPQRSTUVWX';
    await computeScope(NO_REPO, `wire up billing with key ${secret}`, gw, { complexity: 'small' });
    const leaked = spy.mock.calls.some((c) => JSON.stringify(c).includes(secret));
    expect(leaked).toBe(false); // every decompose/explore/synthesize call is redacted
  });
});

describe('autoScopeForPlanning (AO9-3 proactive pre-plan gate)', () => {
  const NO_REPO = '/nonexistent-scope-test-dir';

  it('returns null (no fan-out) for a non-large task — reuses the given complexity', async () => {
    const gw = gwContext();
    const spy = vi.spyOn(gw.gateway as unknown as { chat: () => unknown }, 'chat');
    const result = await autoScopeForPlanning(NO_REPO, gw, 'rename a var', {
      complexity: 'small',
    });
    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled(); // complexity supplied → no probe, gate fails → no scope
  });

  it('scopes a LARGE task and returns grounding markdown', async () => {
    const gw = gwContext();
    const result = await autoScopeForPlanning(NO_REPO, gw, 'add MFA', { complexity: 'large' });
    expect(result).not.toBeNull();
    expect(result!.map.subsystems.length).toBeGreaterThan(0);
    expect(result!.markdown).toContain('# Scope — add MFA');
  });

  it('probes complexity when not supplied and stays silent for a non-large verdict', async () => {
    const gw = gwContext(); // the fake probe answers "medium"
    const spy = vi.spyOn(gw.gateway as unknown as { chat: () => unknown }, 'chat');
    const result = await autoScopeForPlanning(NO_REPO, gw, 'add a small thing');
    expect(result).toBeNull();
    // Exactly the probe ran — no decompose/explore/synthesize fan-out.
    const probed = spy.mock.calls.some((c) => JSON.stringify(c).includes('Rate how broad'));
    const decomposed = spy.mock.calls.some((c) => JSON.stringify(c).includes('exploration angles'));
    expect(probed).toBe(true);
    expect(decomposed).toBe(false);
  });
});
