import type { AgentRole, ExcaliburConfig } from '@excalibur/shared';
import type { ToolSpec } from '@excalibur/model-gateway';

/**
 * Extension tool contract — the STRUCTURAL mirror of `@excalibur/extension-sdk`'s
 * `AgentTool`/`ToolContext`/`ToolResult` (extensions-spec.md §5).
 *
 * `agent-runtime` must NOT import `@excalibur/extension-sdk` (it sits BELOW the
 * SDK in the dependency graph — CONTRACT §3). So the native loop executes
 * extension-contributed tools through this locally-defined, structurally-equal
 * interface: a host that depends on both packages (the CLI) hands the SDK's
 * `AgentTool[]` straight into {@link AgentRunInput.extensionTools} and the shapes
 * line up by structural typing. The one additive field beyond the SDK contract
 * is {@link ExtensionTool.readOnly}, which lets a tool opt into being offered to
 * read-only/planning roles (mirrored on the SDK's `AgentTool`).
 */

/** Minimal logger handed to an extension tool (mirrors `ExtensionLogger`). */
export interface ExtensionToolLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** Execution context handed to an extension tool (mirrors SDK `ToolContext`). */
export interface ExtensionToolContext {
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
  /** Host logger; calls are surfaced on the run's event stream. */
  logger: ExtensionToolLogger;
}

/** Result returned by an extension tool execution (mirrors SDK `ToolResult`). */
export interface ExtensionToolResult {
  /** `true` when the tool ran successfully. */
  success: boolean;
  /** Human/agent-readable output (shown to the model). */
  output: string;
  /** Optional structured payload for programmatic consumers. */
  data?: unknown;
  /** Failure description when `success` is `false`. */
  error?: string;
}

/** Agent tool contributed by an extension (structural mirror of SDK `AgentTool`). */
export interface ExtensionTool {
  /** Unique tool name (e.g. `query_database`, `fetch_ticket`). */
  name: string;
  /** Description shown to the model when the tool is offered. */
  description: string;
  /** JSON-schema-like description of the tool input. */
  inputSchema: unknown;
  execute(input: unknown, context: ExtensionToolContext): Promise<ExtensionToolResult>;
  /**
   * When `true`, the tool is non-mutating and is offered to read-only/planning
   * roles too. Default (absent/false): the tool is treated as mutating and is
   * hidden from read-only roles — third-party code is gated conservatively.
   */
  readOnly?: boolean;
}

/** Narrows an arbitrary registry value to an executable {@link ExtensionTool}. */
export function isExtensionTool(value: unknown): value is ExtensionTool {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const tool = value as Partial<ExtensionTool>;
  return (
    typeof tool.name === 'string' &&
    tool.name.length > 0 &&
    typeof tool.description === 'string' &&
    typeof tool.execute === 'function'
  );
}

/** Coerces a tool's JSON-schema-like input into a model-gateway parameter schema. */
function toParameterSchema(inputSchema: unknown): Record<string, unknown> {
  if (typeof inputSchema === 'object' && inputSchema !== null) {
    return inputSchema as Record<string, unknown>;
  }
  // A tool that declared no schema still needs a valid (empty-object) shape so
  // the provider accepts the tool spec.
  return { type: 'object', properties: {} };
}

/**
 * Builds the JSON-Schema tool specs for extension tools, filtered by role:
 * a read-only role only sees tools that opted in via `readOnly: true`.
 */
export function extensionToolSpecs(
  tools: ReadonlyArray<ExtensionTool>,
  opts: { readOnlyRole: boolean },
): ToolSpec[] {
  return tools
    .filter((tool) => !opts.readOnlyRole || tool.readOnly === true)
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: toParameterSchema(tool.inputSchema),
    }));
}

/** Indexes extension tools by name; on a name clash the LAST tool wins. */
export function extensionToolsByName(
  tools: ReadonlyArray<ExtensionTool>,
): Map<string, ExtensionTool> {
  const byName = new Map<string, ExtensionTool>();
  for (const tool of tools) {
    byName.set(tool.name, tool);
  }
  return byName;
}
