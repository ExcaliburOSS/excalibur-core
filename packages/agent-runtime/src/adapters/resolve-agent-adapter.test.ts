import { describe, expect, it } from 'vitest';
import { ConfigValidationError, DEFAULT_CONFIG, type ExcaliburConfig } from '@excalibur/shared';
import { CustomCommandAdapter } from './custom-command/custom-command-adapter';
import { NativeAgentAdapter } from './native/native-agent-adapter';
import { agentUsesGateway, resolveAgentAdapter } from './resolve-agent-adapter';

function withAgents(agents: Record<string, unknown>): ExcaliburConfig {
  return { ...DEFAULT_CONFIG, agents } as ExcaliburConfig;
}

describe('resolveAgentAdapter', () => {
  it('defaults to the native adapter (unset or explicit native)', () => {
    expect(resolveAgentAdapter(DEFAULT_CONFIG)).toBeInstanceOf(NativeAgentAdapter);
    expect(resolveAgentAdapter(withAgents({ default: 'native' }))).toBeInstanceOf(
      NativeAgentAdapter,
    );
    expect(agentUsesGateway(DEFAULT_CONFIG)).toBe(true);
  });

  it('builds a CustomCommandAdapter for a configured custom-command agent', () => {
    const config = withAgents({
      default: 'claude-code',
      'claude-code': { type: 'custom-command', command: 'claude', args: ['-p', '{{prompt}}'] },
    });
    const adapter = resolveAgentAdapter(config);
    expect(adapter).toBeInstanceOf(CustomCommandAdapter);
    expect(adapter.id).toBe('claude-code');
    // A passthrough does its own inference → it does NOT use the gateway.
    expect(agentUsesGateway(config)).toBe(false);
  });

  it('throws when agents.default names a missing entry', () => {
    expect(() => resolveAgentAdapter(withAgents({ default: 'ghost' }))).toThrow(
      ConfigValidationError,
    );
  });

  it('throws on an unsupported agent type', () => {
    expect(() =>
      resolveAgentAdapter(withAgents({ default: 'weird', weird: { type: 'telepathy' } })),
    ).toThrow(ConfigValidationError);
  });
});
