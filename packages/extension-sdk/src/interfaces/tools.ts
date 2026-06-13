import type { AgentRole, ExcaliburConfig } from '@excalibur/shared';
import type { ExtensionLogger } from '../logger';

/**
 * Agent tool contract (extensions-spec.md §5).
 *
 * Tools registered through `ctx.tools.registerTool` become available to agent
 * adapters alongside the native tools of `@excalibur/agent-runtime`. M1 does
 * not execute extension tools inside runs yet; the interface is the stable
 * surface extensions code against.
 */

/** Execution context handed to a tool by the agent runtime. */
export interface ToolContext {
  /** Absolute path of the working directory the agent operates in. */
  workdir: string;
  /** Local run id when the tool runs inside a run (`run_YYYYMMDD_HHMMSS`). */
  runId?: string;
  /** Agent session id, for event attribution. */
  sessionId?: string;
  /** Role of the agent invoking the tool. */
  role?: AgentRole;
  /** Effective repository configuration. */
  config: ExcaliburConfig;
  logger: ExtensionLogger;
}

/** Result returned by a tool execution. */
export interface ToolResult {
  /** `true` when the tool ran successfully. */
  success: boolean;
  /** Human/agent-readable output (shown to the model). */
  output: string;
  /** Optional structured payload for programmatic consumers. */
  data?: unknown;
  /** Failure description when `success` is `false`. */
  error?: string;
}

export interface AgentTool {
  /** Unique tool name (e.g. `query_database`, `fetch_ticket`). */
  name: string;
  /** Description shown to the model when the tool is offered. */
  description: string;
  /** JSON-schema-like description of the tool input. */
  inputSchema: unknown;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}
