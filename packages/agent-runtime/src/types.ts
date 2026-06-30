import type { AgentRole, ExcaliburConfig, ExcaliburEvent, PhaseType } from '@excalibur/shared';
import type { ChatMessage, ModelGateway } from '@excalibur/model-gateway';
import type { ExtensionTool } from './tools/extension-tools';

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
  /**
   * Optional provider selector (a `providers.yaml` key), forwarded to the
   * gateway so it resolves the real model id from that provider's config.
   * This is the provider NAME (e.g. `groq`), not a model id.
   */
  provider?: string;
  /** Optional model override (a model id), forwarded to the model gateway. */
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
   * Optional free-text human channel for the model-callable `question` tool
   * (P1.8b). When a human is present (interactive shell / interactive run) the
   * CLI passes a reader; the tool returns the typed answer. Absent — or an empty
   * answer — tells the model to proceed on its best judgment (never blocks a
   * headless/CI run). Additive.
   */
  ask?: (question: string) => Promise<string>;
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
  /**
   * Optional in-turn context compactor. Called by the loop before each model
   * call: given the running message array it returns a compacted, PROVIDER-VALID
   * array when the conversation is over budget (so a single long agentic turn
   * never overflows the context window), or null to leave it unchanged. Additive.
   */
  compactContext?: (messages: ChatMessage[]) => Promise<ChatMessage[] | null>;
  /**
   * Optional LIVE narration sink. When the gateway can stream a turn, the loop
   * calls this with the model's prose AS IT ARRIVES (`delta` is the new fragment,
   * `content` the accumulated prose so far) so the UI can type it out token by
   * token. Live-only — it is NOT persisted (the per-turn `model_call` event still
   * carries the full content); omitting it just means the loop does not stream.
   * Additive.
   */
  onNarration?: (chunk: { delta: string; content: string }) => void;
  /**
   * Tools contributed by loaded extensions (extensions-spec.md §5), advertised
   * to the model alongside the native tools and dispatched through their own
   * `execute()` inside the loop. Gated like any other tool by the
   * `PermissionEngine` (`checkTool` defaults unknown/extension tools to `ask`)
   * and offered to read-only roles only when a tool opts in via `readOnly`. The
   * CLI activates extensions and passes the harvested tools here; ordinary
   * in-process callers omit it. Additive.
   */
  extensionTools?: ExtensionTool[];
  /**
   * Self-contained custom agent overrides (P1.7). When a user selects a custom
   * agent (a `.excalibur/agents/<name>.md` file), the CLI resolves it and passes
   * these so the native loop runs with that agent's persona, model, sampling and
   * guardrails. All additive; an ordinary run omits every field.
   */
  /**
   * The agent's persona, used VERBATIM as the system prompt's header in place of
   * the default "You are the Excalibur native agent acting as the <role>" line.
   * The operational protocol (workdir, tool authority, `update_tasks`) is still
   * appended, so a custom prompt never loses the tool-use contract.
   */
  systemPrompt?: string;
  /** Sampling temperature forwarded to the model (omitted → provider default). */
  temperature?: number;
  /**
   * Native tool allowlist. INTERSECTS the role's tool set — it can only NARROW
   * what the role already grants (a read-only role can never be widened to
   * mutate), so deny always wins. Names not in the native catalog are ignored.
   */
  allowedTools?: string[];
  /**
   * Per-agent permission overrides, merged OVER `config.permissions` before the
   * `PermissionEngine` is built (deny lists are unioned — an agent can tighten
   * but the project's denials always still apply).
   */
  permissions?: ExcaliburConfig['permissions'];
  /**
   * Injected MANAGEMENT capabilities (project status, work-items, sprints,
   * plans, …) the agent can call as native tools mid-conversation. The proactive
   * foundation: the agent uses Excalibur's own features per the situation without
   * the user typing a command. Implemented by the host (the CLI/core layer, which
   * owns the stores) since agent-runtime must not depend on @excalibur/core.
   * Absent → the management tools report they are unavailable in this context.
   */
  management?: ManagementToolset;
}

/**
 * Host-provided implementations of Excalibur's management capabilities, surfaced
 * to the model as read-only native tools (so the agent proactively pulls project
 * state into its reasoning). Each method returns the agent-facing TEXT result;
 * an omitted method means the host does not offer that capability here. Args are
 * plain so this stays free of any `@excalibur/core` type dependency.
 */
export interface ManagementToolset {
  /** Project status rollup: runs/patches/interactions, latest activity, work-item lanes. */
  projectStatus?(args: { discovery?: boolean }): Promise<string>;
  /** Query the work-item backlog (board or filtered), or fetch one by key. */
  workItems?(args: {
    status?: string;
    query?: string;
    labels?: string[];
    limit?: number;
    key?: string;
  }): Promise<string>;
  /** The active (or named) sprint with its burndown summary. */
  sprintStatus?(args: { sprintId?: string }): Promise<string>;
  /** List saved plans, or show one (steps + progress) by id. */
  plans?(args: { id?: string }): Promise<string>;
  /** Aggregate usage insights (runs/cost/tokens, per-model/-workflow/-day). */
  insights?(args: { sinceDays?: number }): Promise<string>;
  /** Summarize a past run's recorded event log (a runId, or the latest). */
  runLogs?(args: { runId?: string; limit?: number }): Promise<string>;
  /** List the project's self-contained custom agents. */
  listAgents?(args: Record<string, never>): Promise<string>;
  /** List the project's skills with trust level + enablement. */
  listSkills?(args: Record<string, never>): Promise<string>;
  /** List recent sessions, or summarize one by id. */
  sessions?(args: { id?: string }): Promise<string>;
  /** Run the verification mesh over the current working-tree diff. */
  verify?(args: Record<string, never>): Promise<string>;
  /** Produce a focused review of the current working-tree diff. */
  review?(args: Record<string, never>): Promise<string>;
  /** Persist a durable project-memory node (decision/convention/gotcha) for future runs. */
  remember?(args: { statement: string; subjectPaths?: string[] }): Promise<string>;
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
