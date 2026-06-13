import type {
  AgentRole,
  ExcaliburConfig,
  ExcaliburEvent,
  PhaseType,
} from '@excalibur/shared';
import type { ModelGateway } from '@excalibur/model-gateway';

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
