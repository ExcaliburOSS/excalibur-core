import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  excaliburEventSchema,
  type ExcaliburEvent,
  type ExcaliburEventType,
} from '@excalibur/shared';
import { DEFAULT_PROVIDERS_CONFIG, ModelGateway } from '@excalibur/model-gateway';
import type { AgentRunInput } from '../../types';
import { NATIVE_TOOL_NAMES } from '../../tools/native-tools';
import { NativeAgentAdapter } from './native-agent-adapter';

const PINNED_IMPLEMENTER_ORDER: ExcaliburEventType[] = [
  'tool_call',
  'file_read',
  'model_call',
  'file_write',
  'command_started',
  'command_completed',
  'test_result',
  'patch_generated',
];

/** Non-existent directory: proves the adapter never touches the filesystem. */
const FAKE_WORKDIR = join(tmpdir(), `excalibur-agent-runtime-test-${process.pid}-nonexistent`);

function makeInput(overrides?: Partial<AgentRunInput>): AgentRunInput {
  return {
    runId: 'run_20260613_101500',
    sessionId: 'session_test_1',
    workdir: FAKE_WORKDIR,
    prompt: 'Fix duplicated escrow release in src/escrow/escrow.service.ts on webhook retry',
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

/**
 * Structural unified-diff validator: file sections (`--- a/` + `+++ b/`),
 * hunk headers with consistent old/new line counts, and hunk body lines
 * prefixed with ' ', '+' or '-'.
 */
function expectParseableUnifiedDiff(diff: string): void {
  const lines = diff.split('\n');
  expect(lines[0]).toMatch(/^--- a\//);

  let index = 0;
  let fileSections = 0;
  let hunks = 0;
  while (index < lines.length) {
    expect(lines[index]).toMatch(/^--- a\/.+$/);
    expect(lines[index + 1]).toMatch(/^\+\+\+ b\/.+$/);
    fileSections += 1;
    index += 2;

    // At least one hunk per file section.
    expect(lines[index]).toMatch(/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/);
    while (index < lines.length && lines[index]?.startsWith('@@')) {
      const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(lines[index] ?? '');
      expect(header).not.toBeNull();
      const oldCount = header?.[1] !== undefined ? Number(header[1]) : 1;
      const newCount = header?.[2] !== undefined ? Number(header[2]) : 1;
      hunks += 1;
      index += 1;

      let seenOld = 0;
      let seenNew = 0;
      while (seenOld < oldCount || seenNew < newCount) {
        const line = lines[index];
        expect(line).toBeDefined();
        expect(line).toMatch(/^[ +-]/);
        if (line?.startsWith('+')) {
          seenNew += 1;
        } else if (line?.startsWith('-')) {
          seenOld += 1;
        } else {
          seenOld += 1;
          seenNew += 1;
        }
        index += 1;
      }
      expect(seenOld).toBe(oldCount);
      expect(seenNew).toBe(newCount);
    }
  }
  expect(fileSections).toBeGreaterThan(0);
  expect(hunks).toBeGreaterThan(0);
}

describe('NativeAgentAdapter identity', () => {
  it('is always detected and exposes the nine tools as capabilities', async () => {
    const adapter = new NativeAgentAdapter();
    expect(adapter.id).toBe('native');
    expect(adapter.name.length).toBeGreaterThan(0);
    expect(adapter.capabilities).toEqual([...NATIVE_TOOL_NAMES]);
    await expect(adapter.detect()).resolves.toBe(true);
  });

  it('stop() resolves (no-op in M1)', async () => {
    const adapter = new NativeAgentAdapter();
    await expect(adapter.stop('session_test_1')).resolves.toBeUndefined();
  });
});

describe('NativeAgentAdapter.run — implementer stream', () => {
  it('emits schema-valid events in the contract-pinned order', async () => {
    const events = await collect(new NativeAgentAdapter().run(makeInput()));

    expect(events.map((event) => event.type)).toEqual(PINNED_IMPLEMENTER_ORDER);
    for (const event of events) {
      const parsed = excaliburEventSchema.safeParse(event);
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(
        true,
      );
    }
  });

  it('attributes every event to the run, session and phase', async () => {
    const events = await collect(new NativeAgentAdapter().run(makeInput()));
    for (const event of events) {
      expect(event.runId).toBe('run_20260613_101500');
      expect(event.sessionId).toBe('session_test_1');
      expect(event.phaseId).toBe('implement');
    }
  });

  it('simulates commands and tests without executing anything', async () => {
    const config = {
      ...DEFAULT_CONFIG,
      commands: { ...DEFAULT_CONFIG.commands, test: 'pnpm test' },
    };
    const events = await collect(new NativeAgentAdapter().run(makeInput({ config })));

    const started = events.find((event) => event.type === 'command_started');
    const completed = events.find((event) => event.type === 'command_completed');
    const testResult = events.find((event) => event.type === 'test_result');

    expect(started?.payload).toMatchObject({ command: 'pnpm test', simulated: true });
    expect(completed?.payload).toMatchObject({
      command: 'pnpm test',
      simulated: true,
      exitCode: 0,
    });
    expect(testResult?.payload).toMatchObject({ status: 'passed', simulated: true });
  });

  it('falls back to "npm test" when no test command is configured', async () => {
    const config = { ...DEFAULT_CONFIG, commands: {} };
    const events = await collect(new NativeAgentAdapter().run(makeInput({ config })));
    const started = events.find((event) => event.type === 'command_started');
    expect(started?.payload).toMatchObject({ command: 'npm test' });
  });

  it('carries the mock diff in the patch_generated payload as { diff, filesAffected }', async () => {
    const events = await collect(new NativeAgentAdapter().run(makeInput()));
    const patch = events.find((event) => event.type === 'patch_generated');
    expect(patch).toBeDefined();

    const diff = patch?.payload.diff;
    const filesAffected = patch?.payload.filesAffected;
    expect(typeof diff).toBe('string');
    expect(Array.isArray(filesAffected)).toBe(true);

    expectParseableUnifiedDiff(diff as string);
    expect(filesAffected).toContain('src/escrow/escrow.service.ts');
    expect(diff as string).toContain('+++ b/src/escrow/escrow.service.ts');
  });

  it('uses the gateway (MockProvider) for the assistant text of the model_call event', async () => {
    const events = await collect(new NativeAgentAdapter().run(makeInput()));
    const modelCall = events.find((event) => event.type === 'model_call');
    expect(modelCall).toBeDefined();
    const payload = modelCall?.payload as Record<string, unknown>;
    expect(String(payload.content)).toContain('> Mock provider (M1)');
    expect(payload.model).toBe('mock-model');
    expect(Number(payload.inputTokens)).toBeGreaterThan(0);
    expect(Number(payload.outputTokens)).toBeGreaterThan(0);
    expect(payload.kind).toBe('patch');
  });

  it('honors an explicit model override', async () => {
    const events = await collect(
      new NativeAgentAdapter().run(makeInput({ model: 'mock-large' })),
    );
    const modelCall = events.find((event) => event.type === 'model_call');
    expect(modelCall?.payload.model).toBe('mock-large');
  });

  it('targets the default example file when the prompt mentions no paths', async () => {
    const events = await collect(
      new NativeAgentAdapter().run(makeInput({ prompt: 'Fix the duplicated webhook handling' })),
    );
    const fileRead = events.find((event) => event.type === 'file_read');
    const patch = events.find((event) => event.type === 'patch_generated');
    expect(fileRead?.payload.path).toBe('src/example.service.ts');
    expect(patch?.payload.filesAffected).toContain('src/example.service.ts');
  });

  it('never touches the user filesystem (workdir does not even exist)', async () => {
    expect(existsSync(FAKE_WORKDIR)).toBe(false);
    await collect(new NativeAgentAdapter().run(makeInput()));
    expect(existsSync(FAKE_WORKDIR)).toBe(false);
  });

  it('is deterministic for identical input (ids/timestamps aside)', async () => {
    const first = await collect(new NativeAgentAdapter().run(makeInput()));
    const second = await collect(new NativeAgentAdapter().run(makeInput()));
    expect(first.map((event) => event.type)).toEqual(second.map((event) => event.type));
    const firstPatch = first.find((event) => event.type === 'patch_generated');
    const secondPatch = second.find((event) => event.type === 'patch_generated');
    expect(firstPatch?.payload.diff).toEqual(secondPatch?.payload.diff);
  });
});

describe('NativeAgentAdapter.run — non-implementer roles', () => {
  it('omits patch_generated and selects a role-appropriate response kind', async () => {
    const events = await collect(
      new NativeAgentAdapter().run(
        makeInput({
          role: 'reviewer',
          phase: { id: 'review', name: 'Review', type: 'agent_review' },
        }),
      ),
    );
    expect(events.map((event) => event.type)).toEqual(
      PINNED_IMPLEMENTER_ORDER.slice(0, PINNED_IMPLEMENTER_ORDER.length - 1),
    );
    const modelCall = events.find((event) => event.type === 'model_call');
    expect(modelCall?.payload.kind).toBe('review');
    expect(String(modelCall?.payload.content)).toContain('Code review');
  });

  it('works without a phase (events carry a null phaseId)', async () => {
    const input = makeInput({ role: 'planner' });
    delete input.phase;
    const events = await collect(new NativeAgentAdapter().run(input));
    expect(events.length).toBe(7);
    for (const event of events) {
      expect(event.phaseId).toBeNull();
      expect(excaliburEventSchema.safeParse(event).success).toBe(true);
    }
  });
});
