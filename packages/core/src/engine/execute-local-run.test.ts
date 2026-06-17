import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NativeAgentAdapter } from '@excalibur/agent-runtime';
import { DEFAULT_PROVIDERS_CONFIG, ModelGateway } from '@excalibur/model-gateway';
import type { ChatInput, ChatOutput } from '@excalibur/model-gateway';
import type { ExcaliburEvent, ExcaliburEventType, ExcaliburConfig } from '@excalibur/shared';
import { getDefaultWorkflow } from '@excalibur/workflow-schema';
import { RunManager } from '../runs/run-manager';
import { makeTempDir, removeDir } from '../test-utils';
import { executeLocalRun } from './execute-local-run';

/**
 * Wraps the real (mock) gateway: text phases get the mock's markdown, while the
 * tool-using agent_work turn (which passes `tools`) is scripted to write a real
 * file and then finish — exercising the engine → native adapter → real tools
 * path end-to-end, fully offline.
 */
class ToolDrivenGateway {
  private toolTurns = 0;
  constructor(private readonly inner: ModelGateway) {}

  chat(input: ChatInput): Promise<ChatOutput> {
    if (input.tools === undefined || input.tools.length === 0) {
      return this.inner.chat(input);
    }
    // Agent loop: first turn writes a file, second turn finishes.
    const alreadyWrote = input.messages.some((m) => m.role === 'tool');
    this.toolTurns += 1;
    if (!alreadyWrote) {
      return Promise.resolve({
        content: '',
        model: 'mock-model',
        usage: { inputTokens: 8, outputTokens: 4 },
        costCents: 0,
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call_write_1',
            name: 'write_file',
            arguments: { path: 'src/feature.ts', content: 'export const feature = true;\n' },
          },
        ],
      });
    }
    return Promise.resolve({
      content: 'Implemented src/feature.ts as requested.',
      model: 'mock-model',
      usage: { inputTokens: 12, outputTokens: 6 },
      costCents: 0,
      finishReason: 'stop',
    });
  }
}

/**
 * Like {@link ToolDrivenGateway}, but the adversarial Verification Mesh calls
 * (identified by `metadata.kind` starting with `mesh-`) return a JSON verdict
 * with a HIGH-severity issue → the proportional gate must block the run.
 */
class MeshBlockingGateway {
  private wroteFile = false;
  constructor(private readonly inner: ModelGateway) {}

  chat(input: ChatInput): Promise<ChatOutput> {
    const kind = typeof input.metadata?.['kind'] === 'string' ? input.metadata['kind'] : '';
    if (kind.startsWith('mesh-')) {
      return Promise.resolve({
        content: JSON.stringify({
          clean: false,
          issues: [
            {
              severity: 'high',
              file: 'src/feature.ts',
              problem: 'unguarded division by zero',
              fix: 'guard the divisor',
            },
          ],
        }),
        model: 'mock-model',
        usage: { inputTokens: 10, outputTokens: 8 },
        costCents: 0,
        finishReason: 'stop',
      });
    }
    if (input.tools === undefined || input.tools.length === 0) {
      return this.inner.chat(input);
    }
    if (!this.wroteFile) {
      this.wroteFile = true;
      return Promise.resolve({
        content: '',
        model: 'mock-model',
        usage: { inputTokens: 8, outputTokens: 4 },
        costCents: 0,
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'call_write_1',
            name: 'write_file',
            arguments: { path: 'src/feature.ts', content: 'export const feature = true;\n' },
          },
        ],
      });
    }
    return Promise.resolve({
      content: 'Implemented src/feature.ts as requested.',
      model: 'mock-model',
      usage: { inputTokens: 12, outputTokens: 6 },
      costCents: 0,
      finishReason: 'stop',
    });
  }
}

describe('executeLocalRun', () => {
  let repoRoot: string;
  let runManager: RunManager;
  let gateway: ModelGateway;
  let adapter: NativeAgentAdapter;
  const config: ExcaliburConfig = {
    // Real, fast, deterministic commands — they EXECUTE for real (no simulation);
    // only the LLM is a CI double. `true`/`echo` exit 0 without external deps.
    commands: { test: 'true', typecheck: 'echo typecheck-ok' },
    models: { default: 'mock' },
  };

  beforeEach(() => {
    repoRoot = makeTempDir();
    runManager = new RunManager(repoRoot);
    gateway = new ModelGateway(DEFAULT_PROVIDERS_CONFIG);
    adapter = new NativeAgentAdapter();
  });

  afterEach(() => {
    removeDir(repoRoot);
  });

  function typesOf(events: ExcaliburEvent[]): ExcaliburEventType[] {
    return events.map((event) => event.type);
  }

  it('runs fast-fix end-to-end: REAL commands + REAL git apply, lifecycle events', async () => {
    const definition = getDefaultWorkflow('fast-fix');
    expect(definition).toBeDefined();

    // Real git repo so the apply_patch phase performs a REAL `git apply`. The
    // mock provider emits an APPLIABLE new-file diff (creates the target path),
    // so we must NOT pre-create the file — the real apply creates it.
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@excalibur.local'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Excalibur Test'], { cwd: repoRoot });

    const run = runManager.createRun({
      title: 'Fix duplicated webhook handling in src/escrow/escrow.service.ts',
      autonomyLevel: 3,
      workflow: 'fast-fix',
      methodology: 'fast-fix',
      executionStyle: 'fast',
    });

    const streamed: ExcaliburEvent[] = [];
    const record = await executeLocalRun({
      repoRoot,
      runManager,
      run,
      definition: definition!,
      gateway,
      adapter,
      config,
      onEvent: (event) => streamed.push(event),
    });

    expect(record.status).toBe('completed');
    expect(record.completedAt).not.toBeNull();
    expect(runManager.getRun(run.id).record.status).toBe('completed');

    const events = runManager.readEvents(run.id);
    const types = typesOf(events);

    // Lifecycle bookends (Build Contract §4.6).
    expect(types[0]).toBe('run_started');
    expect(types[1]).toBe('workflow_selected');
    expect(types[2]).toBe('methodology_selected');
    expect(types[types.length - 1]).toBe('run_completed');
    expect(events[events.length - 1]?.payload['status']).toBe('completed');

    // The ISD log event with sources/warnings.
    const log = events.find(
      (event) => event.type === 'policy_decision' && event.payload['kind'] === 'log',
    );
    expect(log).toBeDefined();
    expect(Array.isArray(log?.payload['instructionSources'])).toBe(true);
    expect(Array.isArray(log?.payload['instructionWarnings'])).toBe(true);

    // Every phase has bookends.
    for (const phase of definition!.phases) {
      expect(events.some((e) => e.type === 'phase_started' && e.phaseId === phase.id)).toBe(true);
      expect(events.some((e) => e.type === 'phase_completed' && e.phaseId === phase.id)).toBe(true);
    }

    // patch_generation produced a diff artifact and event.
    const patchEvent = events.find((event) => event.type === 'patch_generated');
    expect(patchEvent).toBeDefined();
    expect(String(patchEvent?.payload['diff'])).toContain('+++');
    expect(readFileSync(join(run.dir, 'diff.patch'), 'utf8')).toContain(
      'src/escrow/escrow.service.ts',
    );

    // apply_patch REALLY applied the diff (no `simulated`) and the working tree changed.
    const applied = events.find((event) => event.type === 'patch_applied');
    expect(applied).toBeDefined();
    expect(applied?.payload['simulated']).toBeUndefined();
    expect(applied?.payload['filesAffected']).toContain('src/escrow/escrow.service.ts');
    expect(readFileSync(join(repoRoot, 'src/escrow/escrow.service.ts'), 'utf8')).toContain(
      'Idempotency guard',
    );
    const autoApproval = events.find((event) => event.type === 'approval_approved');
    expect(autoApproval?.payload['auto']).toBe(true);

    // command_group EXECUTED the configured commands for real (exit 0, no `simulated`).
    const commandEvents = events.filter((event) => event.type === 'command_completed');
    expect(commandEvents.map((event) => event.payload['command'])).toEqual([
      'true',
      'echo typecheck-ok',
    ]);
    for (const event of commandEvents) {
      expect(event.payload['simulated']).toBeUndefined();
      expect(event.payload['exitCode']).toBe(0);
    }
    const testResult = events.find((event) => event.type === 'test_result');
    expect(testResult?.payload['status']).toBe('passed');
    expect(testResult?.payload['simulated']).toBeUndefined();
    const testResults = JSON.parse(readFileSync(join(run.dir, 'test-results.json'), 'utf8')) as {
      status: string;
    };
    expect(testResults).toMatchObject({ status: 'passed' });
    expect((testResults as Record<string, unknown>)['simulated']).toBeUndefined();

    // Static + phase artifacts.
    expect(existsSync(join(run.dir, 'workflow.yaml'))).toBe(true);
    expect(existsSync(join(run.dir, 'methodology.yaml'))).toBe(true);
    expect(existsSync(join(run.dir, 'input.md'))).toBe(true);
    expect(readFileSync(join(run.dir, 'summary.md'), 'utf8')).toContain('Mock provider (M1)');

    // model-calls.jsonl has one line per gateway call.
    const modelCalls = readFileSync(join(run.dir, 'model-calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(modelCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of modelCalls) {
      expect(call['provider']).toBe('mock');
      expect(typeof call['inputTokens']).toBe('number');
    }

    // onEvent saw exactly what was persisted.
    expect(streamed.map((event) => event.id)).toEqual(events.map((event) => event.id));
  });

  it('runs structured-feature end-to-end with the REAL agent tool loop', async () => {
    // The repo must be a git repo so the implementer's patch is a real diff.
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@excalibur.local'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Excalibur Test'], { cwd: repoRoot });

    const definition = getDefaultWorkflow('structured-feature');
    const run = runManager.createRun({
      title: 'Implement contract renewal reminders',
      autonomyLevel: 4,
      workflow: 'structured-feature',
      methodology: 'spec-driven',
      executionStyle: 'structured',
    });

    // The agent_work phase drives the real native loop. The MockProvider is a
    // pure text double (it never requests tools), so for this end-to-end test we
    // wrap it: text phases (context/spec/plan/review/pr) get the mock's markdown,
    // and the tool-using agent_work turn (which passes `tools`) is scripted to
    // really write a file and then finish — exercising engine → adapter → tools.
    const config4: ExcaliburConfig = {
      ...config,
      permissions: { tools: { write_file: true }, allowedCommands: [] },
    };
    const toolDrivenGateway = new ToolDrivenGateway(gateway);

    const record = await executeLocalRun({
      repoRoot,
      runManager,
      run,
      definition: definition!,
      gateway: toolDrivenGateway as unknown as ModelGateway,
      adapter,
      config: config4,
    });

    expect(record.status).toBe('completed');
    const events = runManager.readEvents(run.id);
    const types = typesOf(events);

    // agent_work drove the REAL loop: it requested a tool and wrote a real file.
    expect(types).toContain('tool_call');
    expect(types).toContain('file_write');
    expect(types).toContain('patch_generated');
    const agentEvents = events.filter((event) => event.sessionId !== null);
    expect(agentEvents.length).toBeGreaterThan(0);

    // The diff was collected from the real working-tree change.
    expect(existsSync(join(run.dir, 'diff.patch'))).toBe(true);

    // The agent REALLY created the file in the working tree.
    expect(existsSync(join(repoRoot, 'src/feature.ts'))).toBe(true);

    // Phase output artifacts (text phases used the mock provider).
    for (const artifact of ['context.md', 'spec.md', 'plan.md', 'review.md', 'pr-summary.md']) {
      expect(existsSync(join(run.dir, artifact))).toBe(true);
    }
    expect(readFileSync(join(run.dir, 'review.md'), 'utf8')).toContain('Mock provider (M1)');
  });

  it('BLOCKS completion (failed) when the Verification Mesh finds a high issue', async () => {
    // structured-feature has an agent_review phase, so the proportional gate runs.
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@excalibur.local'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Excalibur Test'], { cwd: repoRoot });

    const definition = getDefaultWorkflow('structured-feature');
    const run = runManager.createRun({
      title: 'Implement contract renewal reminders',
      autonomyLevel: 4,
      workflow: 'structured-feature',
      methodology: 'spec-driven',
      executionStyle: 'structured',
    });

    const config4: ExcaliburConfig = {
      ...config,
      permissions: { tools: { write_file: true }, allowedCommands: [] },
      verification: { mesh: 'auto' },
    };

    const record = await executeLocalRun({
      repoRoot,
      runManager,
      run,
      definition: definition!,
      gateway: new MeshBlockingGateway(gateway) as unknown as ModelGateway,
      adapter,
      config: config4,
    });

    // The gate flips a would-be `completed` run to `failed` (needs-fix).
    expect(record.status).toBe('failed');
    const events = runManager.readEvents(run.id);
    const verdict = events.find((event) => event.type === 'verification');
    expect(verdict).toBeDefined();
    expect(verdict?.payload['blocked']).toBe(true);
    expect(String(verdict?.payload['summary'])).toContain('BLOCKING');
    expect(Array.isArray(verdict?.payload['issues'])).toBe(true);

    // The verdict is persisted as a replayable/auditable artifact.
    const verification = readFileSync(join(run.dir, 'verification.md'), 'utf8');
    expect(verification).toContain('**BLOCKED**');
    expect(verification).toContain('unguarded division by zero');

    // The mesh ran AFTER the phases (the work still happened; only completion is gated).
    expect(events.some((event) => event.type === 'patch_generated')).toBe(true);
    expect(events[events.length - 1]?.payload['status']).toBe('failed');
  });

  it('does NOT run the mesh gate when verification.mesh is off', async () => {
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@excalibur.local'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Excalibur Test'], { cwd: repoRoot });

    const definition = getDefaultWorkflow('structured-feature');
    const run = runManager.createRun({
      title: 'Implement contract renewal reminders',
      autonomyLevel: 4,
      workflow: 'structured-feature',
      methodology: 'spec-driven',
      executionStyle: 'structured',
    });

    const config4: ExcaliburConfig = {
      ...config,
      permissions: { tools: { write_file: true }, allowedCommands: [] },
      verification: { mesh: 'off' },
    };

    const record = await executeLocalRun({
      repoRoot,
      runManager,
      run,
      definition: definition!,
      gateway: new MeshBlockingGateway(gateway) as unknown as ModelGateway,
      adapter,
      config: config4,
    });

    // mesh off → the blocking verdict is never solicited → run completes.
    expect(record.status).toBe('completed');
    expect(existsSync(join(run.dir, 'verification.md'))).toBe(false);
  });

  it('STOPS the run (failed) at the hard budget cap — deny-by-dollars', async () => {
    // Every model call costs 1 cent; the cap is 1 cent → the FIRST call is
    // allowed (spend 0 < cap), the SECOND is DENIED (spend 1 >= cap 1).
    class CostlyGateway {
      chat(): Promise<ChatOutput> {
        return Promise.resolve({
          content: 'ok',
          model: 'mock-model',
          usage: { inputTokens: 5, outputTokens: 5 },
          costCents: 1,
          finishReason: 'stop',
        });
      }
    }
    const definition = getDefaultWorkflow('fast-fix');
    const run = runManager.createRun({
      title: 'Tweak something',
      autonomyLevel: 3,
      workflow: 'fast-fix',
      executionStyle: 'fast',
    });

    const record = await executeLocalRun({
      repoRoot,
      runManager,
      run,
      definition: definition!,
      gateway: new CostlyGateway() as unknown as ModelGateway,
      adapter,
      config,
      budgetCents: 1,
    });

    expect(record.status).toBe('failed');
    const events = runManager.readEvents(run.id);
    const deny = events.find(
      (e) => e.type === 'policy_decision' && e.payload['kind'] === 'budget',
    );
    expect(deny).toBeDefined();
    expect(deny?.payload['decision']).toBe('deny');
    const err = events.find((e) => e.type === 'error' && e.payload['code'] === 'budget_exceeded');
    expect(err).toBeDefined();
    expect(String(err?.payload['message'])).toContain('Budget cap');
  });

  it('does NOT cap when no budget is configured (the default)', async () => {
    // A run with no budgetCents + no config.budget completes normally (the
    // existing fast-fix happy path still holds — the cap is opt-in).
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@excalibur.local'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Excalibur Test'], { cwd: repoRoot });
    const definition = getDefaultWorkflow('fast-fix');
    const run = runManager.createRun({
      title: 'Fix duplicated webhook handling in src/escrow/escrow.service.ts',
      autonomyLevel: 3,
      workflow: 'fast-fix',
      executionStyle: 'fast',
    });
    const record = await executeLocalRun({
      repoRoot,
      runManager,
      run,
      definition: definition!,
      gateway,
      adapter,
      config, // no budget set
    });
    expect(record.status).toBe('completed');
    expect(
      runManager.readEvents(run.id).some((e) => e.payload['kind'] === 'budget'),
    ).toBe(false);
  });

  it('BLOCKS completion (failed) when the diff leaks a secret — claim ledger no_secrets', async () => {
    // The agent writes a file containing an API key; the claim ledger's secret
    // scan refutes `no_secrets` → the run must not reach `completed`. The mesh is
    // made to pass (clean JSON) so this isolates the CLAIM gate.
    execFileSync('git', ['init', '-q'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@excalibur.local'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Excalibur Test'], { cwd: repoRoot });

    class SecretLeakGateway {
      private wrote = false;
      chat(input: ChatInput): Promise<ChatOutput> {
        const kind = typeof input.metadata?.['kind'] === 'string' ? input.metadata['kind'] : '';
        if (kind.startsWith('mesh-')) {
          return Promise.resolve({
            content: '{"clean": true, "issues": []}',
            model: 'mock-model',
            usage: { inputTokens: 4, outputTokens: 4 },
            costCents: 0,
            finishReason: 'stop',
          });
        }
        if (input.tools !== undefined && input.tools.length > 0 && !this.wrote) {
          this.wrote = true;
          return Promise.resolve({
            content: '',
            model: 'mock-model',
            usage: { inputTokens: 8, outputTokens: 4 },
            costCents: 0,
            finishReason: 'tool_calls',
            toolCalls: [
              {
                id: 'w1',
                name: 'write_file',
                arguments: {
                  path: 'src/cfg.ts',
                  content: 'export const apiKey = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";\n',
                },
              },
            ],
          });
        }
        return Promise.resolve({
          content: 'Done — no secrets were introduced.',
          model: 'mock-model',
          usage: { inputTokens: 6, outputTokens: 6 },
          costCents: 0,
          finishReason: 'stop',
        });
      }
    }

    const definition = getDefaultWorkflow('structured-feature');
    const run = runManager.createRun({
      title: 'Add a config module',
      autonomyLevel: 4,
      workflow: 'structured-feature',
      methodology: 'spec-driven',
      executionStyle: 'structured',
    });
    const record = await executeLocalRun({
      repoRoot,
      runManager,
      run,
      definition: definition!,
      gateway: new SecretLeakGateway() as unknown as ModelGateway,
      adapter,
      config: { ...config, permissions: { tools: { write_file: true }, allowedCommands: [] } },
    });

    expect(record.status).toBe('failed');
    const events = runManager.readEvents(run.id);
    const noSecrets = events.find(
      (e) => e.type === 'claim' && e.payload['kind'] === 'no_secrets',
    );
    expect(noSecrets?.payload['status']).toBe('refuted');
    // The model ASSERTED "no secrets" — the ledger caught the lie.
    expect(noSecrets?.payload['asserted']).toBe(true);
    expect(existsSync(join(run.dir, 'claims.md'))).toBe(true);
  });

  it('cancels the run when a required human approval is denied', async () => {
    const definition = getDefaultWorkflow('human-gated');
    expect(definition).toBeDefined();
    const run = runManager.createRun({
      title: 'Carefully gated change',
      autonomyLevel: 4,
      workflow: 'human-gated',
      executionStyle: 'careful',
    });

    const record = await executeLocalRun({
      repoRoot,
      runManager,
      run,
      definition: definition!,
      gateway,
      adapter,
      config,
      confirm: () => Promise.resolve(false),
    });

    expect(record.status).toBe('cancelled');
    const events = runManager.readEvents(run.id);
    expect(events.some((event) => event.type === 'approval_requested')).toBe(true);
    expect(events.some((event) => event.type === 'approval_rejected')).toBe(true);
    expect(events.some((event) => event.type === 'approval_approved')).toBe(false);
    expect(events[events.length - 1]?.type).toBe('run_completed');
    expect(events[events.length - 1]?.payload['status']).toBe('cancelled');
  });

  it('skips a denied optional apply_patch without failing the run', async () => {
    const definition = getDefaultWorkflow('fast-fix');
    const run = runManager.createRun({
      title: 'Fix small bug',
      autonomyLevel: 3,
      workflow: 'fast-fix',
      executionStyle: 'fast',
    });

    const record = await executeLocalRun({
      repoRoot,
      runManager,
      run,
      definition: definition!,
      gateway,
      adapter,
      config,
      confirm: () => Promise.resolve(false),
    });

    expect(record.status).toBe('completed');
    const events = runManager.readEvents(run.id);
    expect(events.some((event) => event.type === 'patch_applied')).toBe(false);
    expect(events.some((event) => event.type === 'approval_rejected')).toBe(true);
  });

  it('marks the run failed and emits an error event when a phase throws', async () => {
    const definition = getDefaultWorkflow('review-only');
    const run = runManager.createRun({
      title: 'Review something',
      autonomyLevel: 0,
      workflow: 'review-only',
    });

    const brokenGateway = {
      chat: () => Promise.reject(new Error('gateway exploded')),
      stream: gateway.stream.bind(gateway),
    } as unknown as ModelGateway;

    const record = await executeLocalRun({
      repoRoot,
      runManager,
      run,
      definition: definition!,
      gateway: brokenGateway,
      adapter,
      config,
    });

    expect(record.status).toBe('failed');
    const events = runManager.readEvents(run.id);
    const errorEvent = events.find((event) => event.type === 'error');
    expect(errorEvent?.payload['message']).toContain('gateway exploded');
    expect(events[events.length - 1]?.type).toBe('run_completed');
    expect(events[events.length - 1]?.payload['status']).toBe('failed');
  });
});
