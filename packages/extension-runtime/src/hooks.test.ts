import { describe, expect, it } from 'vitest';
import { EXCALIBUR_HOOKS, HookRegistry } from './hooks';

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

describe('EXCALIBUR_HOOKS', () => {
  it('pins the 14 lifecycle hook names from the spec', () => {
    expect(EXCALIBUR_HOOKS).toHaveLength(14);
    expect(EXCALIBUR_HOOKS).toContain('run.phaseStarted');
    expect(EXCALIBUR_HOOKS).toContain('discovery.completed');
    expect(EXCALIBUR_HOOKS).toContain('dailySummary.generating');
  });
});

describe('HookRegistry', () => {
  it('delivers the emitted event to all handlers of the hook', async () => {
    const registry = new HookRegistry();
    const received: unknown[] = [];
    registry.on<{ runId: string }>('run.created', (event) => {
      received.push(event.runId);
    });
    registry.on<{ runId: string }>('run.created', async (event) => {
      received.push(`${event.runId}-again`);
    });

    await registry.emit('run.created', { runId: 'run_1' });
    expect(received).toEqual(['run_1', 'run_1-again']);
  });

  it('awaits handlers sequentially in registration order', async () => {
    const registry = new HookRegistry();
    const order: string[] = [];
    registry.on('run.completed', async () => {
      await delay(25); // would finish last if handlers ran concurrently
      order.push('slow');
    });
    registry.on('run.completed', () => {
      order.push('fast');
    });

    await registry.emit('run.completed', {});
    expect(order).toEqual(['slow', 'fast']);
  });

  it('does not call handlers registered for other hooks', async () => {
    const registry = new HookRegistry();
    let called = 0;
    registry.on('pr.opened', () => {
      called += 1;
    });
    await registry.emit('run.failed', {});
    expect(called).toBe(0);
  });

  it('resolves when no handlers are registered', async () => {
    const registry = new HookRegistry();
    await expect(registry.emit('weeklyPlanning.started', {})).resolves.toBeUndefined();
  });

  it('isolates synchronous handler errors and keeps running later handlers', async () => {
    const registry = new HookRegistry();
    const calls: string[] = [];
    registry.on('patch.created', () => {
      throw new Error('sync boom');
    });
    registry.on('patch.created', () => {
      calls.push('survivor');
    });

    await expect(registry.emit('patch.created', {})).resolves.toBeUndefined();
    expect(calls).toEqual(['survivor']);
    expect(registry.errors()).toHaveLength(1);
    expect(registry.errors()[0]?.hookName).toBe('patch.created');
    expect(registry.errors()[0]?.message).toBe('sync boom');
  });

  it('isolates rejected async handlers too and collects every failure', async () => {
    const registry = new HookRegistry();
    registry.on('run.failed', async () => {
      await delay(1);
      throw new Error('async boom');
    });
    registry.on('run.failed', () => {
      throw new Error('second boom');
    });

    await registry.emit('run.failed', { reason: 'tests' });
    expect(registry.errors().map((e) => e.message)).toEqual(['async boom', 'second boom']);
  });

  it('collects non-Error throw values with a readable message', async () => {
    const registry = new HookRegistry();
    registry.on('interaction.created', () => {
      // Deliberately throw a non-Error value to exercise message normalization.
      throw 'string failure';
    });
    await registry.emit('interaction.created', {});
    expect(registry.errors()[0]?.message).toBe('string failure');
    expect(registry.errors()[0]?.error).toBe('string failure');
  });

  it('reports handler counts', () => {
    const registry = new HookRegistry();
    expect(registry.handlerCount('run.created')).toBe(0);
    registry.on('run.created', () => undefined);
    registry.on('run.created', () => undefined);
    expect(registry.handlerCount('run.created')).toBe(2);
  });
});
