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

function makeInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    runId: 'run_20260613_111500',
    sessionId: 'session_custom_1',
    workdir: process.cwd(),
    prompt: 'Fix the webhook retry bug',
    role: 'implementer',
    config: DEFAULT_CONFIG,
    gateway: new ModelGateway(DEFAULT_PROVIDERS_CONFIG),
    phase: { id: 'implement', name: 'Implement', type: 'agent_work' },
    ...overrides,
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

describe('CustomCommandAdapter.run (subprocess passthrough)', () => {
  // Tiny node programs stand in for a vendor CLI — deterministic, no network.
  const ECHO_STDIN =
    'let s="";process.stdin.on("data",d=>{s+=d});process.stdin.on("end",()=>process.stdout.write("ECHO:"+s))';

  it('feeds the prompt via stdin (no {{prompt}} token) and maps stdout to assistant_message', async () => {
    const adapter = new CustomCommandAdapter({
      id: 'echo',
      command: process.execPath,
      args: ['-e', ECHO_STDIN],
    });
    const events = await collect(adapter.run(makeInput({ prompt: 'hello there' })));
    expect(events.every((e) => excaliburEventSchema.safeParse(e).success)).toBe(true);
    expect(events.map((e) => e.type)).toEqual([
      'run_started',
      'assistant_message',
      'run_completed',
    ]);
    expect(String(events[1]?.payload.content)).toBe('ECHO:hello there');
    expect(events[0]?.runId).toBe('run_20260613_111500');
    expect(events[0]?.phaseId).toBe('implement');
    expect(events[0]?.sessionId).toBe('session_custom_1');
  });

  it('substitutes {{prompt}} into the args when the token is present', async () => {
    const adapter = new CustomCommandAdapter({
      id: 'argprompt',
      command: process.execPath,
      args: ['-e', 'process.stdout.write("GOT:"+process.argv[1])', '{{prompt}}'],
    });
    const events = await collect(adapter.run(makeInput({ prompt: 'do the thing' })));
    expect(events.map((e) => e.type)).toEqual([
      'run_started',
      'assistant_message',
      'run_completed',
    ]);
    expect(String(events[1]?.payload.content)).toBe('GOT:do the thing');
  });

  it('emits an error event on a non-zero exit (capturing the exit code + stderr)', async () => {
    const adapter = new CustomCommandAdapter({
      id: 'failer',
      command: process.execPath,
      args: ['-e', 'process.stderr.write("boom");process.exit(3)'],
    });
    const events = await collect(adapter.run(makeInput()));
    expect(events.map((e) => e.type)).toEqual(['run_started', 'error']);
    expect(events[1]?.payload).toMatchObject({ code: 'agent_exit_nonzero', exitCode: 3 });
    expect(String(events[1]?.payload.stderr)).toContain('boom');
  });

  it('emits a spawn_failed error when the binary is missing (never throws)', async () => {
    const adapter = new CustomCommandAdapter({
      id: 'ghost',
      command: 'excalibur-definitely-not-a-real-binary-7f3a',
    });
    const events = await collect(adapter.run(makeInput()));
    expect(events.map((e) => e.type)).toEqual(['run_started', 'error']);
    expect(events[1]?.payload.code).toBe('agent_spawn_failed');
  });

  it('emits an aborted error when the signal is already aborted', async () => {
    const adapter = new CustomCommandAdapter({
      id: 'long',
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
    });
    const events = await collect(adapter.run(makeInput({ signal: AbortSignal.abort() })));
    expect(events.map((e) => e.type)).toEqual(['run_started', 'error']);
    expect(events[1]?.payload.code).toBe('aborted');
  });
});
