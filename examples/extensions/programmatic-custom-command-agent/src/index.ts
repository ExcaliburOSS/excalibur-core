import { spawnSync } from 'node:child_process';
import {
  defineExtension,
  type AgentAdapter,
  type AgentRunInput,
} from '@excalibur/extension-sdk';
import { createEvent, type ExcaliburEvent } from '@excalibur/shared';

/**
 * Example programmatic Excalibur extension: registers an `AgentAdapter` that
 * wraps an external CLI agent (here a fictional `acme-agent` binary).
 *
 * The adapter contract is event-streaming: `run()` yields canonical
 * `ExcaliburEvent`s (created with `createEvent` from `@excalibur/shared`) and
 * the core engine forwards them into the run's `events.jsonl`.
 *
 * M1 honesty note: Excalibur M1 never executes external commands inside runs
 * (the built-in CustomCommandAdapter behaves the same way), so `run()` below
 * describes the invocation it would make and then yields a single honest
 * `error` event. Real external agent execution activates in M3 — when it
 * does, replace the body of `run()` with the actual spawn + stream parsing.
 */

const DEFAULT_COMMAND = 'acme-agent';

/** Resolves `true` when `command` is executable on the current PATH. */
function isCommandOnPath(command: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, [command], { stdio: 'ignore' });
  return result.status === 0;
}

export class AcmeCommandAgentAdapter implements AgentAdapter {
  readonly id = 'acme-agent';
  readonly name = 'Acme CLI Agent';
  /** Capabilities stay empty until the adapter really drives the CLI (M3). */
  readonly capabilities: string[] = [];

  private readonly command: string;
  private readonly extraArgs: ReadonlyArray<string>;

  constructor(options?: { command?: string; extraArgs?: ReadonlyArray<string> }) {
    this.command = options?.command ?? DEFAULT_COMMAND;
    this.extraArgs = options?.extraArgs ?? [];
  }

  detect(): Promise<boolean> {
    return Promise.resolve(isCommandOnPath(this.command));
  }

  async *run(input: AgentRunInput): AsyncIterable<ExcaliburEvent> {
    const phaseId = input.phase?.id ?? null;
    const invocation = [this.command, ...this.extraArgs, '--task', input.prompt].join(' ');

    yield createEvent({
      runId: input.runId,
      type: 'tool_call',
      phaseId,
      sessionId: input.sessionId,
      payload: {
        tool: 'custom_command_agent',
        command: this.command,
        args: [...this.extraArgs, '--task', input.prompt],
        workdir: input.workdir,
        role: input.role,
        simulated: true,
      },
    });

    yield createEvent({
      runId: input.runId,
      type: 'error',
      phaseId,
      sessionId: input.sessionId,
      payload: {
        message:
          `Custom command agent "${this.id}" cannot execute "${invocation}" yet: ` +
          'external agent execution activates in M3. This adapter currently ' +
          'validates configuration and detection only.',
        recoverable: true,
      },
    });
  }

  stop(_sessionId: string): Promise<void> {
    // Nothing runs in M1; with real execution (M3) this kills the child process.
    return Promise.resolve();
  }
}

export default defineExtension({
  id: 'programmatic-custom-command-agent',
  name: 'Custom Command Agent (example)',
  version: '0.1.0',
  description:
    'Registers an agent adapter wrapping an external CLI agent, plus a run.completed hook.',
  register(ctx) {
    // Host-resolved configuration (see configSchema in the manifest).
    const command = typeof ctx.config['command'] === 'string' ? ctx.config['command'] : undefined;
    const extraArgs =
      typeof ctx.config['extraArgs'] === 'string'
        ? ctx.config['extraArgs'].split(' ').filter((arg) => arg.length > 0)
        : undefined;

    const adapterOptions: { command?: string; extraArgs?: ReadonlyArray<string> } = {};
    if (command !== undefined) {
      adapterOptions.command = command;
    }
    if (extraArgs !== undefined) {
      adapterOptions.extraArgs = extraArgs;
    }

    ctx.agents.registerAdapter(new AcmeCommandAgentAdapter(adapterOptions));

    // Hooks: subscribe to lifecycle events emitted by the core. Handler
    // errors are isolated by the HookRegistry — they never break a run.
    ctx.hooks.on<{ runId?: string }>('run.completed', (event) => {
      ctx.logger.info(`acme-agent extension saw run ${event.runId ?? '(unknown)'} complete`);
    });

    ctx.logger.info('programmatic-custom-command-agent registered');
  },
});
