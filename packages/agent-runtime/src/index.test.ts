import { describe, expect, it } from 'vitest';
import * as agentRuntime from './index';
import type { AgentAdapter, AgentRunInput } from './index';

describe('@excalibur/agent-runtime public API (Build Contract §4.4)', () => {
  it('exports the pinned values', () => {
    expect(Array.isArray(agentRuntime.NATIVE_TOOLS)).toBe(true);
    expect(agentRuntime.NATIVE_TOOLS).toHaveLength(9);
    expect(typeof agentRuntime.PermissionEngine).toBe('function');
    expect(typeof agentRuntime.NativeAgentAdapter).toBe('function');
    expect(typeof agentRuntime.CustomCommandAdapter).toBe('function');
  });

  it('NativeAgentAdapter and CustomCommandAdapter satisfy the AgentAdapter interface', () => {
    const native: AgentAdapter = new agentRuntime.NativeAgentAdapter();
    const custom: AgentAdapter = new agentRuntime.CustomCommandAdapter({
      id: 'claude-code',
      command: 'claude',
    });
    for (const adapter of [native, custom]) {
      expect(typeof adapter.id).toBe('string');
      expect(typeof adapter.name).toBe('string');
      expect(Array.isArray(adapter.capabilities)).toBe(true);
      expect(typeof adapter.detect).toBe('function');
      expect(typeof adapter.run).toBe('function');
    }
  });

  it('PermissionDecision has the pinned shape', () => {
    const decision: agentRuntime.PermissionDecision = new agentRuntime.PermissionEngine().checkPath(
      'src/app.ts',
      'read',
    );
    expect(Object.keys(decision).sort()).toEqual(['allowed', 'reason', 'requiresConfirmation']);
  });

  it('AgentRunInput type accepts the pinned fields (compile-time check)', () => {
    // Type-level assertion: this object must satisfy AgentRunInput.
    const probe: Omit<AgentRunInput, 'gateway' | 'config'> = {
      runId: 'run_20260613_120000',
      sessionId: 'session_1',
      workdir: '/tmp/repo',
      prompt: 'Fix the bug',
      role: 'implementer',
      model: 'mock-model',
      phase: { id: 'implement', name: 'Implement', type: 'agent_work' },
    };
    expect(probe.runId.length).toBeGreaterThan(0);
  });
});
