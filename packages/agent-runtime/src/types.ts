import type {
  AgentRole,
  ExcaliburConfig,
  ExcaliburEvent,
  PhaseType,
} from '@excalibur/shared';
import type { ChatMessage, ModelGateway } from '@excalibur/model-gateway';

/**
 * Agent adapter contract (Build Contract §4.4, OSS spec §15).
 *
 * Adapters wrap a concrete agent implementation (the built-in native agent,
 * an external CLI agent, …) behind a uniform, event-streaming interface so the
 * core engine can execute `agent_work` phases without knowing which agent runs
 * underneath. These shapes are reused by Excalibur Enterprise: renaming or
 * removing a member is a breaking change.
 */

/** Workflow phase the agent is running, attributed on every emitted event. */
export interface AgentRunPhaseRef {
  id: string;
  name: string;
  type: PhaseType;
}

export interface AgentRunInput {
  /** Local run id (`run_YYYYMMDD_HHMMSS`); stamped on every emitted event. */
  runId: string;
  /** Agent session id, used for event attribution and `stop()`. */
  sessionId: string;
  /** Absolute path of the working directory the agent operates in. */
  workdir: string;
  /** Task prompt (the core engine prepends effective instructions itself). */
  prompt: string;
  role: AgentRole;
  /** Optional model override, forwarded to the model gateway. */
  model?: string;
  phase?: AgentRunPhaseRef;
  config: ExcaliburConfig;
  gateway: ModelGateway;
  /**
   * Optional approver for tools the permission engine marks
   * `requiresConfirmation` (mutating actions outside the allowlist, `ask`
   * tools). Resolving `false` — or omitting the callback entirely — declines
   * the action: the native loop NEVER auto-executes a mutating tool the engine
   * says needs confirmation when there is no confirmer (safe default). Additive.
   */
  confirm?: (req: ConfirmationRequest) => Promise<boolean>;
  /**
   * Optional abort signal. Aborting stops the native tool loop at the next
   * iteration boundary (and is forwarded to the gateway for in-flight cancel).
   * Additive — existing callers pass neither `confirm` nor `signal`.
   */
  signal?: AbortSignal;
  /**
   * Cached conversation prefix seeded ahead of the task prompt (time-machine
   * fork-from-cache, T2). When present, the loop starts the conversation as
   * `[system, ...seedMessages, {user: prompt}]` instead of `[system, {user:
   * prompt}]` — i.e. the reconstructed turns of the source run (assistant
   * thoughts, tool calls and their results up to the fork point) are replayed
   * as context WITHOUT re-spending a single token, and only the new `prompt`
   * (the fork instruction) runs live. Must be a valid, self-consistent message
   * list (every `tool` message answers a preceding `assistant` tool call).
   * Additive — ordinary runs omit it.
   */
  seedMessages?: ChatMessage[];
}

/** A request to a human/approver to confirm a mutating tool invocation. */
export interface ConfirmationRequest {
  /** Tool name the model wants to call (e.g. `write_file`, `run_command`). */
  tool: string;
  /** Why confirmation is required (the permission engine's reason). */
  reason: string;
  /** Optional human-readable detail (e.g. the path or command at stake). */
  detail?: string;
}

export interface AgentAdapter {
  /** Stable adapter id (e.g. `native`, `claude-code`). */
  id: string;
  /** Human-readable adapter name. */
  name: string;
  /** Capability identifiers (the native adapter lists its tool names). */
  capabilities: string[];
  /** Resolves `true` when the adapter can run on this machine. */
  detect(): Promise<boolean>;
  /** Executes the agent and streams canonical Excalibur events. */
  run(input: AgentRunInput): AsyncIterable<ExcaliburEvent>;
  /** Optionally stops a running agent session. */
  stop?(sessionId: string): Promise<void>;
}
