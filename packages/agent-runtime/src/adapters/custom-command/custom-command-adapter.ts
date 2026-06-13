import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { z } from 'zod';
import {
  ConfigValidationError,
  createEvent,
  type ExcaliburEvent,
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
 * M1 behavior: `detect()` really checks the binary on PATH, but `run()` only
 * yields a single honest `error` event — custom-command execution activates
 * in M3.
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
export function isCommandOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
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

  /** M1: yields a single honest `error` event — execution activates in M3. */
  async *run(input: AgentRunInput): AsyncIterable<ExcaliburEvent> {
    yield createEvent({
      runId: input.runId,
      type: 'error',
      phaseId: input.phase?.id ?? null,
      sessionId: input.sessionId,
      payload: {
        code: 'agent_adapter_not_available',
        adapter: this.id,
        command: this.command,
        message:
          `Custom command agent "${this.id}" ("${this.command}") cannot run yet: ` +
          'custom-command adapters activate in M3. M1 runs use the native adapter.',
      },
    });
  }
}
