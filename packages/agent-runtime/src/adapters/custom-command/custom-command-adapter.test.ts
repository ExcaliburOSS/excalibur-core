import { describe, expect, it } from 'vitest';
import {
  ConfigValidationError,
  DEFAULT_CONFIG,
  excaliburEventSchema,
  type ExcaliburEvent,
} from '@excalibur/shared';
import { DEFAULT_PROVIDERS_CONFIG, ModelGateway } from '@excalibur/model-gateway';
import type { AgentRunInput } from '../../types';
import {
  CustomCommandAdapter,
  customCommandAgentConfigSchema,
  isCommandOnPath,
} from './custom-command-adapter';

function makeInput(): AgentRunInput {
  return {
    runId: 'run_20260613_111500',
    sessionId: 'session_custom_1',
    workdir: '/tmp/does-not-matter',
    prompt: 'Fix the webhook retry bug',
    role: 'implementer',
    config: DEFAULT_CONFIG,
    gateway: new ModelGateway(DEFAULT_PROVIDERS_CONFIG),
    phase: { id: 'implement', name: 'Implement', type: 'agent_work' },
  };
}

async function collect(iterable: AsyncIterable<ExcaliburEvent>): Promise<ExcaliburEvent[]> {
  const events: ExcaliburEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe('CustomCommandAdapter construction', () => {
  it('exposes id, display name, command and args', () => {
    const adapter = new CustomCommandAdapter({
      id: 'claude-code',
      name: 'Claude Code',
      command: 'claude',
      args: ['--print', '{{prompt}}'],
    });
    expect(adapter.id).toBe('claude-code');
    expect(adapter.name).toBe('Claude Code');
    expect(adapter.command).toBe('claude');
    expect(adapter.args).toEqual(['--print', '{{prompt}}']);
    expect(adapter.capabilities).toEqual([]);
  });

  it('defaults the display name to the id and args to []', () => {
    const adapter = new CustomCommandAdapter({ id: 'aider', command: 'aider' });
    expect(adapter.name).toBe('aider');
    expect(adapter.args).toEqual([]);
  });

  it('throws ConfigValidationError on an empty command or id', () => {
    expect(() => new CustomCommandAdapter({ id: 'bad', command: '  ' })).toThrow(
      ConfigValidationError,
    );
    expect(() => new CustomCommandAdapter({ id: ' ', command: 'claude' })).toThrow(
      ConfigValidationError,
    );
  });
});

describe('CustomCommandAdapter.fromConfig', () => {
  it('accepts the OSS spec §15 config shape', () => {
    const adapter = CustomCommandAdapter.fromConfig('claude-code', {
      type: 'custom-command',
      command: 'claude',
      args: ['--print', '{{prompt}}'],
    });
    expect(adapter.id).toBe('claude-code');
    expect(adapter.command).toBe('claude');
  });

  it('rejects invalid entries with a readable ConfigValidationError', () => {
    expect(() => CustomCommandAdapter.fromConfig('broken', { type: 'native' })).toThrow(
      ConfigValidationError,
    );
    try {
      CustomCommandAdapter.fromConfig('broken', { type: 'custom-command' });
      expect.unreachable('fromConfig must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).message).toContain('broken');
      expect((error as ConfigValidationError).message).toContain('command');
    }
  });

  it('schema validates the documented YAML shape', () => {
    expect(
      customCommandAgentConfigSchema.safeParse({
        type: 'custom-command',
        command: 'aider',
        args: ['--message', '{{prompt}}'],
      }).success,
    ).toBe(true);
    expect(
      customCommandAgentConfigSchema.safeParse({ type: 'custom-command', command: '' }).success,
    ).toBe(false);
  });
});

describe('CustomCommandAdapter.detect', () => {
  it('detects a binary that exists on PATH (node runs this test)', async () => {
    const adapter = new CustomCommandAdapter({ id: 'node-agent', command: 'node' });
    await expect(adapter.detect()).resolves.toBe(true);
  });

  it('does not detect a binary that is missing from PATH', async () => {
    const adapter = new CustomCommandAdapter({
      id: 'ghost',
      command: 'excalibur-definitely-not-a-real-binary-7f3a',
    });
    await expect(adapter.detect()).resolves.toBe(false);
  });

  it('isCommandOnPath handles explicit paths and empty input', () => {
    expect(isCommandOnPath('')).toBe(false);
    expect(isCommandOnPath('/definitely/not/a/real/path/binary')).toBe(false);
    expect(isCommandOnPath(process.execPath)).toBe(true);
  });
});

describe('CustomCommandAdapter.run', () => {
  it('yields exactly one schema-valid error event explaining M3 activation', async () => {
    const adapter = new CustomCommandAdapter({ id: 'claude-code', command: 'claude' });
    const events = await collect(adapter.run(makeInput()));

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toBeDefined();
    expect(excaliburEventSchema.safeParse(event).success).toBe(true);
    expect(event?.type).toBe('error');
    expect(event?.runId).toBe('run_20260613_111500');
    expect(event?.sessionId).toBe('session_custom_1');
    expect(event?.phaseId).toBe('implement');
    expect(event?.payload).toMatchObject({
      code: 'agent_adapter_not_available',
      adapter: 'claude-code',
      command: 'claude',
    });
    expect(String(event?.payload.message)).toContain('M3');
  });
});
