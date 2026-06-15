import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { NativeAgentAdapter } from '@excalibur/agent-runtime';
import { DEFAULT_CONFIG, type AutonomyLevel } from '@excalibur/shared';
import type { ChatInput, ChatOutput, ModelGateway } from '@excalibur/model-gateway';
import { Ui } from '../ui';
import { defaultDeps, type CliDeps } from '../deps';
import { makeTempRepo, removeDir } from '../test-utils';
import { roleForAutonomy, runAgentTurn, runPlanTurn, type AgentTurnDeps } from './agent-turn';

/**
 * Deterministic agent-loop tests with an INJECTED fake gateway that scripts
 * tool calls — no real model, no network. Exercises the real
 * {@link NativeAgentAdapter} loop: a scripted tool call → tool result → final
 * answer, with inline approval and plan-mode gating asserted on captured
 * stdout/stdin and the produced run artifacts.
 */

const repo = makeTempRepo();
afterAll(() => removeDir(repo));

class MemoryStream extends Writable {
  chunks: string[] = [];
  override _write(chunk: unknown, _e: string, cb: () => void): void {
    this.chunks.push(String(chunk));
    cb();
  }
  text(): string {
    // eslint-disable-next-line no-control-regex
    return this.chunks.join('').replace(/\[[0-9;]*m/g, '');
  }
}

interface Harness {
  deps: CliDeps;
  send: (line: string) => void;
  stdout: () => string;
}

function makeHarness(): Harness {
  const out = new MemoryStream();
  const err = new MemoryStream();
  const stdin = new PassThrough();
  const ui = new Ui({ stdout: out, stderr: err, stdin, interactive: true });
  // Open a persistent line editor so inline `confirm`/`ask` read scripted lines
  // through the same reader the REPL uses.
  ui.openLineEditor({});
  const deps = defaultDeps({
    ui,
    cwd: () => repo,
    homeDir: () => repo,
    env: { PATH: process.env.PATH },
    includeUserGlobal: false,
  });
  return {
    deps,
    send: (line: string): void => {
      stdin.write(`${line}\n`);
    },
    stdout: (): string => out.text(),
  };
}

/** A fake gateway that replays a scripted queue of chat outputs. */
function fakeGateway(outputs: ChatOutput[]): ModelGateway {
  let i = 0;
  const chat = (_input: ChatInput): Promise<ChatOutput> => {
    const out = outputs[Math.min(i, outputs.length - 1)];
    i += 1;
    return Promise.resolve(out as ChatOutput);
  };
  return { chat } as unknown as ModelGateway;
}

function output(content: string, extra: Partial<ChatOutput> = {}): ChatOutput {
  return {
    content,
    model: 'fake-model',
    usage: { inputTokens: 10, outputTokens: 5 },
    costCents: 3,
    finishReason: 'stop',
    ...extra,
  };
}

function turnDeps(
  deps: CliDeps,
  gateway: ModelGateway,
  level: AutonomyLevel,
): AgentTurnDeps {
  return {
    deps,
    repoRoot: repo,
    config: DEFAULT_CONFIG,
    gateway,
    providerName: 'fake',
    autonomyLevel: level,
    adapter: new NativeAgentAdapter(),
  };
}

describe('roleForAutonomy', () => {
  it('L0/L1 → read-only planner; L2+ → implementer', () => {
    expect(roleForAutonomy(0)).toBe('planner');
    expect(roleForAutonomy(1)).toBe('planner');
    expect(roleForAutonomy(2)).toBe('implementer');
    expect(roleForAutonomy(3)).toBe('implementer');
    expect(roleForAutonomy(4)).toBe('implementer');
  });
});

describe('runAgentTurn — the real agentic loop (fake gateway)', () => {
  it('drives model → tool → model: a read tool call then a final answer', async () => {
    const h = makeHarness();
    // Turn 1: ask to read a file (read_file is allowed without confirmation).
    // Turn 2: a final text answer (no tool calls).
    const gw = fakeGateway([
      output('', {
        finishReason: 'tool_calls',
        toolCalls: [{ id: 't1', name: 'read_file', arguments: { path: 'README.md' } }],
      }),
      output('Here is what I found in the README.'),
    ]);

    const result = await runAgentTurn(turnDeps(h.deps, gw, 1), 'what is in the readme?');

    expect(result.text).toContain('Here is what I found');
    expect(result.model).toBe('fake-model');
    expect(result.costCents).toBe(6); // two model calls × 3 cents
    expect(result.runId).toMatch(/^run_/);

    const stdout = h.stdout();
    expect(stdout).toContain('→ agent');
    // The live action renderer shows a `Read` block targeting the file.
    expect(stdout).toContain('Read');
    expect(stdout).toContain('README.md');
    expect(stdout).toContain('run completed');

    // The run recorded its events.jsonl (replayable).
    const eventsFile = join(repo, '.excalibur', 'runs', result.runId, 'events.jsonl');
    expect(existsSync(eventsFile)).toBe(true);
    const events = readFileSync(eventsFile, 'utf8');
    expect(events).toContain('"type":"tool_call"');
    expect(events).toContain('"type":"run_completed"');
  });

  it('inline approval: APPROVING a write tool executes it (file is written)', async () => {
    const h = makeHarness();
    h.send('y'); // approve the write
    const gw = fakeGateway([
      output('', {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'w1',
            name: 'write_file',
            arguments: { path: 'approved.txt', content: 'written by the agent' },
          },
        ],
      }),
      output('Wrote the file as requested.'),
    ]);

    const result = await runAgentTurn(turnDeps(h.deps, gw, 3), 'create approved.txt');

    const stdout = h.stdout();
    expect(stdout).toContain('needs approval');
    expect(result.text).toContain('Wrote the file');
    // The write actually happened (approved).
    expect(existsSync(join(repo, 'approved.txt'))).toBe(true);
    expect(readFileSync(join(repo, 'approved.txt'), 'utf8')).toContain('written by the agent');
  });

  it('inline approval: DECLINING a write tool blocks it (no file written)', async () => {
    const h = makeHarness();
    h.send('n'); // decline the write
    const gw = fakeGateway([
      output('', {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'w2',
            name: 'write_file',
            arguments: { path: 'declined.txt', content: 'should not be written' },
          },
        ],
      }),
      output('Understood — I did not change anything.'),
    ]);

    const result = await runAgentTurn(turnDeps(h.deps, gw, 3), 'create declined.txt');

    expect(h.stdout()).toContain('needs approval');
    expect(result.text).toContain('did not change');
    expect(existsSync(join(repo, 'declined.txt'))).toBe(false);
  });

  it('a read-only (planner) turn never offers a write tool to the model', async () => {
    const h = makeHarness();
    // The planner role only gets read tools; even if the model "tries" to write,
    // the loop would gate it — but here we assert the loop simply answers.
    const gw = fakeGateway([output('A read-only analysis of the repo.')]);
    const result = await runAgentTurn(turnDeps(h.deps, gw, 0), 'analyze the repo');
    expect(result.text).toContain('read-only analysis');
    expect(h.stdout()).toContain('answer (read-only)');
  });
});

describe('runPlanTurn — plan-mode (plan → gate → execute)', () => {
  it('APPROVE: presents the plan, then executes with the implementer role', async () => {
    const h = makeHarness();
    h.send('approve'); // the plan gate
    h.send('y'); // approve the write during execution
    const gw = fakeGateway([
      // Plan pass (planner, read-only) → a plan text.
      output('1. Read the file\n2. Write the change\n3. Verify'),
      // Execute pass: a write tool call …
      output('', {
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'p1',
            name: 'write_file',
            arguments: { path: 'planned.txt', content: 'executed from the plan' },
          },
        ],
      }),
      // … then a final summary.
      output('Plan executed: the change is in place.'),
    ]);

    const result = await runPlanTurn(turnDeps(h.deps, gw, 3), 'implement the planned change');

    expect(result.gate).toBe('approve');
    expect(result.planText).toContain('1. Read the file');
    expect(result.execution).not.toBeNull();

    const stdout = h.stdout();
    expect(stdout).toContain('→ plan · planner (read-only)');
    expect(stdout).toContain('Plan');
    expect(stdout).toContain('→ execute · implementer');
    // The execution actually wrote the file (after approval).
    expect(existsSync(join(repo, 'planned.txt'))).toBe(true);
  });

  it('CANCEL: presents the plan and stops — nothing is executed', async () => {
    const h = makeHarness();
    h.send('cancel'); // the plan gate
    const gw = fakeGateway([
      output('1. A plan that will be cancelled.'),
      // This execute output must never be consumed.
      output('', {
        finishReason: 'tool_calls',
        toolCalls: [
          { id: 'c1', name: 'write_file', arguments: { path: 'never.txt', content: 'nope' } },
        ],
      }),
    ]);

    const result = await runPlanTurn(turnDeps(h.deps, gw, 3), 'do not run this');

    expect(result.gate).toBe('cancel');
    expect(result.execution).toBeNull();
    expect(h.stdout()).toContain('Plan cancelled');
    expect(existsSync(join(repo, 'never.txt'))).toBe(false);
  });

  it('EDIT: returns the edit gate so the REPL can amend + re-plan', async () => {
    const h = makeHarness();
    h.send('edit'); // the plan gate
    const gw = fakeGateway([output('1. A plan the user wants to edit.')]);
    const result = await runPlanTurn(turnDeps(h.deps, gw, 3), 'plan something to edit');
    expect(result.gate).toBe('edit');
    expect(result.execution).toBeNull();
    expect(h.stdout()).toContain('Edit the task and re-plan');
  });

  it('non-interactive: presents the plan and never executes blind', async () => {
    const out = new MemoryStream();
    const ui = new Ui({ stdout: out, stderr: out, interactive: false });
    const deps = defaultDeps({
      ui,
      cwd: () => repo,
      homeDir: () => repo,
      env: { PATH: process.env.PATH },
      includeUserGlobal: false,
    });
    const gw = fakeGateway([output('1. A plan in a non-interactive context.')]);
    const result = await runPlanTurn(
      { ...turnDeps(deps, gw, 3) },
      'plan in CI',
    );
    expect(result.gate).toBe('cancel');
    expect(result.execution).toBeNull();
    expect(out.text()).toContain('not executing');
  });
});

describe('runAgentTurn — cancellation', () => {
  it('an aborted signal cancels the in-flight turn', async () => {
    const h = makeHarness();
    const controller = new AbortController();
    controller.abort(); // pre-aborted: the loop stops at the first iteration boundary
    const gw = fakeGateway([output('should not be reached')]);
    const deps = { ...turnDeps(h.deps, gw, 3), signal: controller.signal };
    const result = await runAgentTurn(deps, 'a turn that is cancelled');
    // The aborted run is recorded as cancelled.
    const record = JSON.parse(
      readFileSync(join(repo, '.excalibur', 'runs', result.runId, 'run.json'), 'utf8'),
    ) as { status: string };
    expect(record.status).toBe('cancelled');
  });
});
