import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { z } from 'zod';
import {
  ConfigValidationError,
  createEvent,
  type ExcaliburEvent,
  type ExcaliburEventType,
} from '@excalibur/shared';
import type { AgentAdapter, AgentRunInput } from '../../types';

/**
 * Custom-command agent adapter (Build Contract §4.4, OSS spec §15).
 *
 * Wraps an external CLI agent configured under the `agents:` section, e.g.:
 *
 * ```yaml
 * agents:
 *   default: native
 *   claude-code:
 *     type: custom-command
 *     command: "claude"
 *     args: ["--print", "{{prompt}}"]
 * ```
 *
 * `detect()` checks the binary on PATH; `run()` drives it as a subprocess,
 * inheriting the environment so the wrapped tool uses ITS OWN auth (e.g. a
 * logged-in vendor CLI holding a subscription) — Excalibur never reads or
 * forwards a credential. This is the legitimate "use your subscription" path:
 * the vendor's own client does the inference, Excalibur only orchestrates it.
 */

/** `agents.<id>` entry shape for `type: custom-command` (OSS spec §15). */
export const customCommandAgentConfigSchema = z
  .object({
    type: z.literal('custom-command'),
    command: z.string().min(1, 'command must not be empty'),
    args: z.array(z.string()).optional(),
    name: z.string().min(1).optional(),
  })
  .strict();
export type CustomCommandAgentConfig = z.infer<typeof customCommandAgentConfigSchema>;

const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

function isExecutableFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) {
      return false;
    }
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether a command resolves to an executable. Commands containing a
 * path separator are checked directly; bare names are searched on PATH
 * (honoring PATHEXT on Windows).
 */
export function isCommandOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return isExecutableFile(trimmed);
  }

  const pathValue = env.PATH ?? env.Path ?? '';
  const extensions =
    process.platform === 'win32'
      ? ['', ...(env.PATHEXT ?? WINDOWS_DEFAULT_PATHEXT).split(';').filter((e) => e.length > 0)]
      : [''];

  for (const dir of pathValue.split(delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    for (const extension of extensions) {
      if (isExecutableFile(join(dir, trimmed + extension))) {
        return true;
      }
    }
  }
  return false;
}

export interface CustomCommandAdapterOptions {
  /** Adapter id — the key under the config `agents:` section. */
  id: string;
  /** Binary to invoke (bare name searched on PATH, or a concrete path). */
  command: string;
  /** Argument template; `{{prompt}}` is substituted in M3. */
  args?: string[];
  /** Display name (defaults to the id). */
  name?: string;
}

export class CustomCommandAdapter implements AgentAdapter {
  readonly id: string;
  readonly name: string;
  /** Unknown until the adapter can really drive the external CLI (M3). */
  readonly capabilities: string[] = [];
  readonly command: string;
  readonly args: ReadonlyArray<string>;

  constructor(options: CustomCommandAdapterOptions) {
    if (options.id.trim().length === 0) {
      throw new ConfigValidationError('Custom command agent id must not be empty.');
    }
    if (options.command.trim().length === 0) {
      throw new ConfigValidationError(
        `Custom command agent "${options.id}" has an empty command.`,
        { agent: options.id },
      );
    }
    this.id = options.id;
    this.name = options.name ?? options.id;
    this.command = options.command;
    this.args = options.args ?? [];
  }

  /**
   * Builds an adapter from a raw `agents.<id>` config entry.
   *
   * @throws ConfigValidationError when the entry does not match the
   *   `custom-command` config shape of OSS spec §15.
   */
  static fromConfig(id: string, value: unknown): CustomCommandAdapter {
    const result = customCommandAgentConfigSchema.safeParse(value);
    if (!result.success) {
      const problems = result.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `${path}: ${issue.message}`;
      });
      throw new ConfigValidationError(
        `Agent "${id}" is not a valid custom-command configuration: ${problems.join('; ')}`,
        { agent: id, problems },
      );
    }
    const options: CustomCommandAdapterOptions = {
      id,
      command: result.data.command,
    };
    if (result.data.args !== undefined) {
      options.args = result.data.args;
    }
    if (result.data.name !== undefined) {
      options.name = result.data.name;
    }
    return new CustomCommandAdapter(options);
  }

  /** Resolves `true` when the configured binary exists on PATH. */
  detect(): Promise<boolean> {
    return Promise.resolve(isCommandOnPath(this.command));
  }

  /**
   * Runs the external CLI as a subprocess and maps its output to canonical
   * events. The task prompt is substituted into any `{{prompt}}` arg token; with
   * no token it is written to the child's stdin. The child INHERITS the
   * environment so the wrapped tool uses its own auth/credential store —
   * Excalibur never reads or forwards a token. No shell is used (args are an
   * array), so the prompt can never inject a command. Emits `run_started`, then
   * `assistant_message` + `run_completed` on a clean exit, or `error` on a
   * non-zero exit / spawn failure / abort.
   */
  async *run(input: AgentRunInput): AsyncIterable<ExcaliburEvent> {
    const emit = (type: ExcaliburEventType, payload: Record<string, unknown>): ExcaliburEvent =>
      createEvent({
        runId: input.runId,
        type,
        phaseId: input.phase?.id ?? null,
        sessionId: input.sessionId,
        payload,
      });

    yield emit('run_started', { adapter: this.id, command: this.command });

    const hasPromptToken = this.args.some((arg) => arg.includes('{{prompt}}'));
    const args = this.args.map((arg) => arg.replaceAll('{{prompt}}', input.prompt));
    const stdin = hasPromptToken ? undefined : input.prompt;

    const result = await this.spawnProcess(args, input.workdir, stdin, input.signal);

    if (result.kind === 'spawn_error') {
      yield emit('error', {
        code: 'agent_spawn_failed',
        adapter: this.id,
        command: this.command,
        message: `Could not start "${this.command}": ${result.message}. Is it installed and on PATH?`,
      });
      return;
    }
    if (result.kind === 'aborted') {
      yield emit('error', {
        code: 'aborted',
        adapter: this.id,
        message: `"${this.command}" was cancelled.`,
      });
      return;
    }
    if (result.exitCode !== 0) {
      yield emit('error', {
        code: 'agent_exit_nonzero',
        adapter: this.id,
        command: this.command,
        exitCode: result.exitCode,
        message: `"${this.command}" exited with code ${result.exitCode}.`,
        stderr: truncate(result.stderr),
      });
      return;
    }
    const content = result.stdout.trim();
    if (content.length > 0) {
      yield emit('assistant_message', { adapter: this.id, content });
    }
    yield emit('run_completed', { adapter: this.id, exitCode: 0 });
  }

  /**
   * Spawns the command (no shell), feeds `stdin` when provided, and resolves
   * with the captured output. Never rejects: a spawn failure, non-zero exit or
   * abort each map to a discriminated result the caller turns into an event.
   */
  private spawnProcess(
    args: string[],
    cwd: string,
    stdin: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<SpawnResult> {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(this.command, args, { cwd, env: process.env, shell: false });
      } catch (error) {
        resolve({
          kind: 'spawn_error',
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const onAbort = (): void => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already exited */
        }
      };
      const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ kind: 'spawn_error', message: error.message });
      });
      child.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (signal?.aborted) {
          resolve({ kind: 'aborted' });
        } else {
          resolve({ kind: 'exit', exitCode: code ?? 0, stdout, stderr });
        }
      });
      // Feeding stdin must tolerate a child that has already exited or been killed (e.g. an
      // already-aborted signal SIGTERMs it above): a write to a closed pipe surfaces
      // ASYNCHRONOUSLY as an EPIPE 'error' on the stream — not a throw — which, with no
      // listener, becomes an unhandled error that crashes the process (a CI-flaky EPIPE).
      // Swallow it; the 'close'/'error' handlers own the real result.
      child.stdin?.on('error', () => {
        /* broken pipe on a spawned/killed child — the result comes from close/error */
      });
      if (stdin !== undefined && signal?.aborted !== true) {
        try {
          child.stdin?.write(stdin);
        } catch {
          /* pipe already gone */
        }
      }
      try {
        child.stdin?.end();
      } catch {
        /* already closed */
      }
    });
  }
}

/** Result of a subprocess run — never an exception (the caller maps it to events). */
type SpawnResult =
  | { kind: 'exit'; exitCode: number; stdout: string; stderr: string }
  | { kind: 'spawn_error'; message: string }
  | { kind: 'aborted' };

/** Caps captured stderr put on an event so a chatty tool can't bloat the log. */
function truncate(text: string, max = 2000): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}\n…(truncated)` : trimmed;
}
