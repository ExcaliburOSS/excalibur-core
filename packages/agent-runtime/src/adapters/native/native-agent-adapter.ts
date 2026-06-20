import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createEvent,
  DEFAULT_LSP_CONFIG,
  type AgentRole,
  type DiagnosticsPayload,
  type ExcaliburConfig,
  type ExcaliburEvent,
  type ExcaliburEventType,
} from '@excalibur/shared';
import { redactSecrets } from '@excalibur/model-gateway';
import type {
  ChatMessage,
  ChatOutput,
  ModelGateway,
  ToolCall,
  ToolSpec,
} from '@excalibur/model-gateway';
import {
  NATIVE_TOOLS,
  NATIVE_TOOL_NAMES,
  isNativeToolName,
  type NativeToolDefinition,
  type NativeToolName,
} from '../../tools/native-tools';
import { zodToJsonSchema } from '../../tools/zod-to-json-schema';
import { executeNativeTool, type ToolExecutionContext } from '../../tools/execute-tool';
import { resolveLocalSearxng } from '../../tools/web/searxng-manager';
import { PermissionEngine } from '../../permissions/permission-engine';
import { createLspSession, languageForFile, type LspSession } from '../../lsp';
import {
  asJsonObject,
  closeMcp,
  connectMcpServers,
  mcpResultToText,
  type ConnectedMcp,
  type McpToolEntry,
} from '../../mcp/mcp-tools';
import type { AgentAdapter, AgentRunInput } from '../../types';

/**
 * Native agent adapter — the REAL agentic tool loop (OSS-7, M2).
 *
 * The adapter drives a bounded chat → tool → chat loop against the model
 * gateway. When the model requests a tool, the adapter runs it through
 * {@link executeNativeTool} (path-confined, permission-gated, redacted), feeds
 * the result back as a `tool` message and continues; when the model replies
 * with no tool calls it emits the final assistant turn and stops. The loop is
 * bounded by {@link MAX_ITERATIONS} and cancelable via `input.signal`.
 *
 * Security model (defense in depth):
 *  - every tool runs under {@link PermissionEngine}; `deny` → declined result;
 *  - mutating tools the engine marks `requiresConfirmation` are gated by
 *    `input.confirm` — NO confirmer (or a `false`) DECLINES without executing;
 *  - tool results and command output are redacted before re-entering the
 *    prompt or an emitted event;
 *  - the tool layer confines every path to `input.workdir`.
 */

/** Hard upper bound on chat↔tool iterations (anti-runaway). */
export const MAX_ITERATIONS = 25;

const execFileAsync = promisify(execFile);

/** Tools a read-only / planning role is allowed to use (no mutation, no exec). */
const READ_ONLY_TOOLS: ReadonlyArray<NativeToolName> = [
  'read_file',
  'list_files',
  'search_code',
  'git_diff',
  // Maintaining the checklist has no side effects, so even a read-only/planning
  // role may surface its plan as a live to-do list.
  'update_tasks',
  // Reading the web is non-mutating research — planners/reviewers get it too.
  'web_fetch',
  // Web search is pure discovery (returns links/snippets, mutates nothing).
  'web_search',
];

/** Roles that get the read-only tool subset (they observe, they do not change the tree). */
const READ_ONLY_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>([
  'planner',
  'architect',
  'reviewer',
  'security',
  'discovery_reviewer',
  'ux_reviewer',
  'growth_reviewer',
  'scope_guardian',
  'product_strategist',
  'customer_researcher',
]);

/** Maps the agent role onto the MockProvider response kind (Contract §7). */
const ROLE_TO_RESPONSE_KIND: Partial<Record<AgentRole, string>> = {
  planner: 'plan',
  architect: 'alternatives',
  implementer: 'patch',
  reviewer: 'review',
  tester: 'test_generation',
  security: 'review',
  release: 'summary',
};

/** Tool name → the canonical Excalibur event type emitted for its result. */
function eventTypeForTool(name: NativeToolName): ExcaliburEventType {
  switch (name) {
    case 'read_file':
    case 'list_files':
    case 'search_code':
      return 'file_read';
    case 'write_file':
      return 'file_write';
    case 'apply_patch':
      return 'patch_applied';
    case 'create_branch':
      return 'branch_created';
    case 'git_diff':
      return 'tool_call';
    case 'run_command':
    case 'run_tests':
      return 'command_completed';
    case 'update_tasks':
      return 'task_update';
    case 'web_fetch':
    case 'web_search':
      return 'tool_call';
  }
}

/** Builds the JSON-Schema tool specs the gateway sends to the model. */
function toolSpecsFor(role: AgentRole): ToolSpec[] {
  const allowed: ReadonlyArray<NativeToolName> = READ_ONLY_ROLES.has(role)
    ? READ_ONLY_TOOLS
    : NATIVE_TOOL_NAMES;
  const defs: ReadonlyArray<NativeToolDefinition> = NATIVE_TOOLS.filter((def) =>
    allowed.includes(def.name),
  );
  return defs.map((def) => ({
    name: def.name,
    description: def.description,
    parameters: zodToJsonSchema(def.parameters),
  }));
}

/**
 * Reviewer/security roles run an ADVERSARIAL review (the "review adversarial
 * interno" differentiator): a skeptic that tries to REFUTE the work, not
 * rubber-stamp it. Surfaced to the human pre-filtered.
 */
function adversarialPreamble(role: AgentRunInput['role']): string[] {
  if (role !== 'reviewer' && role !== 'security') {
    return [];
  }
  const lens =
    role === 'security'
      ? 'Focus on security: injection, secret handling, auth, unsafe shell/network, data exposure.'
      : 'Focus on correctness, regressions, edge cases, and whether the change actually does what was asked.';
  return [
    'You are an ADVERSARIAL reviewer: your job is to REFUTE the work, not approve it.',
    'Read the actual changes (git diff / the files) and actively hunt for what is WRONG.',
    lens,
    'List each issue as: [severity high|medium|low] <file>:<where> — <problem> → <concrete fix>.',
    'Do NOT rubber-stamp. If after a genuine hunt you find nothing, say so explicitly and',
    'state exactly what you verified (so the human can trust the green).',
  ];
}

function systemPromptFor(input: AgentRunInput): string {
  const phase =
    input.phase !== undefined ? ` for phase "${input.phase.name}" (${input.phase.type})` : '';
  return [
    `You are the Excalibur native agent acting as the "${input.role}" role${phase}.`,
    ...adversarialPreamble(input.role),
    `Working directory: ${input.workdir}.`,
    'You can call the provided tools to read and change the repository. Tool results',
    'are authoritative — obey them and adapt when a tool reports an error or a',
    'permission denial.',
    'For any task with more than one step, FIRST call `update_tasks` with the full',
    'checklist (each step as a separate item), then keep it current as you work:',
    'mark exactly one item "in_progress", flip finished items to "completed", and',
    'send the whole list again each time. It is shown to the user as a live to-do',
    'list. Skip it only for trivial one-step tasks.',
    'When the task is complete, reply with a concise final summary and no further',
    'tool calls.',
  ].join('\n');
}

/** The narrowed gateway dependency the loop uses — lets tests inject a fake. */
export type ChatRunner = Pick<ModelGateway, 'chat'>;

interface RunningTotals {
  inputTokens: number;
  outputTokens: number;
  costCents: number | null;
}

export class NativeAgentAdapter implements AgentAdapter {
  readonly id = 'native';
  readonly name = 'Excalibur Native Agent';
  /** The native adapter's capabilities are exactly its nine tools. */
  readonly capabilities: string[] = [...NATIVE_TOOL_NAMES];

  private readonly stoppedSessions = new Set<string>();

  /** The native adapter is built in — always available. */
  detect(): Promise<boolean> {
    return Promise.resolve(true);
  }

  /** Records the session as stopped; the loop checks this between iterations. */
  stop(sessionId: string): Promise<void> {
    this.stoppedSessions.add(sessionId);
    return Promise.resolve();
  }

  /**
   * The real agentic loop. Streams canonical Excalibur events as it drives the
   * model and executes tools. The loop terminates when the model replies with
   * no tool calls, at {@link MAX_ITERATIONS}, or on abort/stop.
   */
  async *run(input: AgentRunInput): AsyncIterable<ExcaliburEvent> {
    const emit = (type: ExcaliburEventType, payload: Record<string, unknown>): ExcaliburEvent =>
      createEvent({
        runId: input.runId,
        type,
        payload,
        phaseId: input.phase?.id ?? null,
        sessionId: input.sessionId,
      });

    const permissions = new PermissionEngine(input.config.permissions);
    const searchCfg = input.config.search;
    const toolCtx: ToolExecutionContext = {
      workdir: input.workdir,
      config: input.config,
      permissions,
      // Thread the run's abort signal so ESC/abort SIGKILLs an in-flight
      // command/test/git process instead of waiting for it to finish.
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      // web_search: resolve a reachable local SearXNG (probe, and start an
      // existing stopped container when managed) — else null → DuckDuckGo.
      searchEnv: process.env,
      resolveSearxng: () =>
        resolveLocalSearxng({
          autoStart: searchCfg?.manageSearxng ?? true,
          ...(searchCfg?.baseUrl !== undefined ? { baseUrl: searchCfg.baseUrl } : {}),
        }),
    };
    // MCP (Model Context Protocol) clients are connected INSIDE the try below so
    // the `finally` that calls closeMcp() always reclaims their subprocesses —
    // even if the consumer abandons this generator at the warnings yield, before
    // the loop. Declared here (empty) so it is in scope for both try and finally.
    let mcp: ConnectedMcp = {
      specs: [],
      byName: new Map<string, McpToolEntry>(),
      clients: [],
      warnings: [],
    };
    // LSP per-edit diagnostics (P1.10): a run-scoped session that spawns a
    // language server lazily on the first edit and feeds compiler errors back to
    // the model. Declared here so the `finally` can always close it; created in
    // the try (it spawns nothing until an edit of a supported, installed language).
    let lsp: LspSession | null = null;
    const responseKind = ROLE_TO_RESPONSE_KIND[input.role] ?? 'ask';
    const mutated = new Set<string>();
    const totals: RunningTotals = { inputTokens: 0, outputTokens: 0, costCents: null };

    // Fork-from-cache (T2): when a cached prefix is supplied, replay the source
    // run's reconstructed turns as context ahead of the new instruction — zero
    // tokens re-spent on the prefix, only `input.prompt` runs live. The system
    // prompt is always freshly built for THIS run's role/workdir/phase.
    const messages: ChatMessage[] =
      input.seedMessages !== undefined && input.seedMessages.length > 0
        ? [
            { role: 'system', content: systemPromptFor(input) },
            ...input.seedMessages,
            { role: 'user', content: input.prompt },
          ]
        : [
            { role: 'system', content: systemPromptFor(input) },
            { role: 'user', content: input.prompt },
          ];

    const aborted = (): boolean =>
      input.signal?.aborted === true || this.stoppedSessions.has(input.sessionId);

    let wasAborted = false;
    let wasErrored = false;
    let finalContent = '';

    try {
      // Connect MCP servers for acting roles only (read-only planner roles get
      // native read tools only — an external MCP tool might mutate), then merge
      // their namespaced specs into the model's tool list. A server that fails to
      // start is skipped with a warning; MCP never breaks the run.
      const mcpServers = input.config.mcp?.servers;
      if (
        !READ_ONLY_ROLES.has(input.role) &&
        mcpServers !== undefined &&
        Object.keys(mcpServers).length > 0
      ) {
        mcp = await connectMcpServers(mcpServers);
      }
      for (const warning of mcp.warnings) {
        yield emit('policy_decision', { kind: 'log', decision: 'allow', message: warning });
      }
      // Editing roles get an LSP session (read-only roles never mutate files).
      // Gated by config; inert until the first edit of an installed language.
      const lspCfg = input.config.lsp;
      if (!READ_ONLY_ROLES.has(input.role) && (lspCfg?.enabled ?? true)) {
        lsp = createLspSession({
          workdir: input.workdir,
          config: lspCfg ?? DEFAULT_LSP_CONFIG,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        });
      }
      const tools = [...toolSpecsFor(input.role), ...mcp.specs];

      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
        if (aborted()) {
          wasAborted = true;
          break;
        }

        const chatInput: Parameters<ChatRunner['chat']>[0] = {
          messages,
          tools,
          metadata: {
            kind: responseKind,
            role: input.role,
            runId: input.runId,
            phaseId: input.phase?.id ?? null,
            iteration,
          },
        };
        if (input.provider !== undefined) {
          chatInput.provider = input.provider;
        }
        if (input.model !== undefined) {
          chatInput.model = input.model;
        }
        if (input.signal !== undefined) {
          chatInput.signal = input.signal;
        }

        // A model can return invalid JSON tool arguments (→ a typed ProviderError
        // from parseToolArguments) or the provider can fail transiently. Either
        // would otherwise propagate out of this generator and TERMINATE the run.
        // Catch it, surface a graceful (redacted) `error` event, and end the run
        // cleanly so consumers always see a final completion turn.
        let output: ChatOutput;
        try {
          output = await input.gateway.chat(chatInput);
        } catch (error) {
          wasErrored = true;
          const code =
            typeof (error as { code?: unknown }).code === 'string'
              ? ((error as { code: string }).code as string)
              : 'provider_error';
          const reason = error instanceof Error ? error.message : String(error);
          yield emit('error', {
            code,
            iteration,
            message: `The model returned an invalid tool call / a provider error: ${redactSecrets(reason)}`,
          });
          finalContent =
            'Run ended early: the model returned an invalid tool call or the provider failed.';
          break;
        }
        totals.inputTokens += output.usage.inputTokens;
        totals.outputTokens += output.usage.outputTokens;
        if (output.costCents !== null) {
          totals.costCents = (totals.costCents ?? 0) + output.costCents;
        }

        yield emit('model_call', {
          model: output.model,
          kind: responseKind,
          iteration,
          inputTokens: output.usage.inputTokens,
          outputTokens: output.usage.outputTokens,
          costCents: output.costCents,
          finishReason: output.finishReason,
          content: redactSecrets(output.content),
        });

        const toolCalls = output.toolCalls ?? [];
        if (toolCalls.length === 0) {
          // Final answer — no more tools requested.
          yield emit('assistant_message', {
            content: redactSecrets(output.content),
            totalInputTokens: totals.inputTokens,
            totalOutputTokens: totals.outputTokens,
            totalCostCents: totals.costCents,
            iterations: iteration + 1,
          });
          // Implementer turns surface the real working-tree diff for the engine.
          for (const ev of await this.maybeEmitPatch(input, mutated, emit)) {
            yield ev;
          }
          return;
        }

        // Record the assistant turn that requested the tools.
        messages.push({ role: 'assistant', content: output.content, toolCalls });
        finalContent = output.content;

        for (const call of toolCalls) {
          if (aborted()) {
            wasAborted = true;
            break;
          }
          for (const ev of await this.runToolCall(
            input,
            toolCtx,
            call,
            mutated,
            emit,
            mcp.byName,
            lsp,
          )) {
            yield ev.event;
            if (ev.toolMessage !== undefined) {
              messages.push(ev.toolMessage);
            }
          }
        }

        if (wasAborted) {
          break;
        }
      }
    } finally {
      closeMcp(mcp);
      lsp?.close();
    }

    // Reached only on abort, a provider/tool-call error, or iteration-limit
    // exhaustion (the final-answer path returns inside the loop).
    const endMessage = wasAborted
      ? 'Native agent run was aborted before completion.'
      : wasErrored
        ? 'Native agent run ended early after a provider/tool-call error.'
        : `Native agent reached the step limit (${MAX_ITERATIONS} iterations) before finishing.`;
    yield emit('policy_decision', {
      kind: 'log',
      decision: 'deny',
      message: endMessage,
    });

    // Distinct finalContent per end state so consumers know WHY the run ended:
    // an aborted run is "Run aborted." (not the iteration-limit "truncated"
    // case); an errored run keeps the graceful error summary set above.
    if (wasAborted && finalContent.length === 0) {
      finalContent = 'Run aborted.';
    }
    yield emit('assistant_message', {
      content: redactSecrets(finalContent),
      truncated: true,
      ...(wasAborted ? { aborted: true } : {}),
      ...(wasErrored ? { errored: true } : {}),
      totalInputTokens: totals.inputTokens,
      totalOutputTokens: totals.outputTokens,
      totalCostCents: totals.costCents,
    });
    for (const ev of await this.maybeEmitPatch(input, mutated, emit)) {
      yield ev;
    }
  }

  /**
   * Executes one tool call under the permission gate and confirm-or-decline
   * policy. Returns the events to stream plus the `tool` message to feed back.
   */
  private async runToolCall(
    input: AgentRunInput,
    ctx: ToolExecutionContext,
    call: ToolCall,
    mutated: Set<string>,
    emit: (type: ExcaliburEventType, payload: Record<string, unknown>) => ExcaliburEvent,
    mcpByName: ReadonlyMap<string, McpToolEntry>,
    lsp: LspSession | null,
  ): Promise<Array<{ event: ExcaliburEvent; toolMessage?: ChatMessage }>> {
    const events: Array<{ event: ExcaliburEvent; toolMessage?: ChatMessage }> = [];

    // MCP tool (namespaced `mcp__<server>__<tool>`) → route to its server,
    // gated by confirmation (external tools always require approval).
    const mcpEntry = mcpByName.get(call.name);
    if (mcpEntry !== undefined) {
      return this.runMcpToolCall(input, call, mcpEntry, emit);
    }

    if (!isNativeToolName(call.name)) {
      const result = `unknown tool "${call.name}"`;
      events.push({
        event: emit('tool_call', { tool: call.name, error: result }),
        toolMessage: { role: 'tool', toolCallId: call.id, content: result },
      });
      return events;
    }
    const toolName = call.name;

    // The tool_call event never carries raw secrets (arguments are redacted).
    events.push({
      event: emit('tool_call', {
        tool: toolName,
        arguments: redactArgs(call.arguments),
      }),
    });

    // Confirm-or-decline gate for any tool the engine marks requiresConfirmation.
    const gate = this.confirmationGate(ctx.permissions, toolName, call.arguments, ctx.config);
    // A HARD DENY (e.g. permissions.tools.apply_patch = false, or a blocked
    // path) is never overridable by confirmation — short-circuit like a decline.
    if (!gate.allowed) {
      const result = `denied: ${gate.reason}`;
      events.push({
        event: emit('policy_decision', {
          kind: 'confirmation',
          tool: toolName,
          decision: 'deny',
          message: result,
        }),
        toolMessage: { role: 'tool', toolCallId: call.id, content: result },
      });
      return events;
    }
    if (gate.requiresConfirmation) {
      const detail = describeCall(toolName, call.arguments);
      const approved =
        input.confirm !== undefined
          ? await input.confirm({
              tool: toolName,
              reason: gate.reason,
              ...(detail !== undefined ? { detail } : {}),
            })
          : false;
      if (!approved) {
        const result = `user declined: ${gate.reason}`;
        events.push({
          event: emit('policy_decision', {
            kind: 'confirmation',
            tool: toolName,
            decision: 'deny',
            message: result,
          }),
          toolMessage: { role: 'tool', toolCallId: call.id, content: result },
        });
        return events;
      }
    }

    const { ok, result } = await executeNativeTool(toolName, call.arguments, ctx);

    // The files THIS call just edited (the per-call delta) — used both to grow
    // the run-wide `mutated` set and to scope the per-edit LSP diagnostics query.
    const editedNow: string[] = [];
    if (ok) {
      const target = pathArgOf(toolName, call.arguments);
      if (target !== undefined && (toolName === 'write_file' || toolName === 'apply_patch')) {
        editedNow.push(target);
      }
      if (toolName === 'apply_patch') {
        editedNow.push(...filesAffectedFromDiff(String(call.arguments['diff'] ?? '')));
      }
      for (const path of editedNow) {
        mutated.add(path);
      }
    }

    // Per-edit diagnostics: query the language server for the just-edited files
    // of a supported language, emit a typed `diagnostics` event each, and append
    // the errors to THIS tool result so the model self-corrects next turn.
    let diagnosticsNote = '';
    if (lsp !== null && editedNow.length > 0) {
      const targets = [...new Set(editedNow)].filter((path) => languageForFile(path) !== null);
      for (const path of targets) {
        const language = languageForFile(path);
        if (language !== null) lsp.ensureStarted(language);
      }
      for (const path of targets) {
        const diag = await lsp.diagnosticsFor(path);
        if (diag === null) continue;
        events.push({ event: emit('diagnostics', diag as unknown as Record<string, unknown>) });
        if (diag.errorCount > 0 || diag.warningCount > 0) {
          diagnosticsNote += formatDiagnosticsForModel(diag);
        }
      }
    }

    const eventType = eventTypeForTool(toolName);
    const payload = toolEventPayload(toolName, call.arguments, ok, result);
    const content =
      diagnosticsNote.length > 0 ? `${result}\n\n${redactSecrets(diagnosticsNote)}` : result;
    events.push({
      event: emit(eventType, payload),
      toolMessage: { role: 'tool', toolCallId: call.id, content },
    });
    return events;
  }

  /**
   * Executes one MCP tool call: announce → confirm (external tools ALWAYS require
   * approval; no confirmer ⇒ declined) → route to the owning server's
   * `callTool`. The result text (redacted) becomes the model's tool message; a
   * transport/tool failure is reported as a tool result, never thrown.
   */
  private async runMcpToolCall(
    input: AgentRunInput,
    call: ToolCall,
    entry: McpToolEntry,
    emit: (type: ExcaliburEventType, payload: Record<string, unknown>) => ExcaliburEvent,
  ): Promise<Array<{ event: ExcaliburEvent; toolMessage?: ChatMessage }>> {
    const events: Array<{ event: ExcaliburEvent; toolMessage?: ChatMessage }> = [];
    events.push({
      event: emit('tool_call', {
        tool: call.name,
        server: entry.serverName,
        arguments: redactArgs(call.arguments),
      }),
    });

    const reason = `external MCP tool "${entry.toolName}" (server: ${entry.serverName})`;
    const approved =
      input.confirm !== undefined
        ? await input.confirm({ tool: call.name, reason, detail: entry.toolName })
        : false;
    if (!approved) {
      const result = `user declined: ${reason}`;
      events.push({
        event: emit('policy_decision', {
          kind: 'confirmation',
          tool: call.name,
          decision: 'deny',
          message: result,
        }),
        toolMessage: { role: 'tool', toolCallId: call.id, content: result },
      });
      return events;
    }

    try {
      const output = await entry.client.callTool(entry.toolName, asJsonObject(call.arguments));
      const text = redactSecrets(mcpResultToText(output));
      events.push({
        event: emit('tool_call', {
          tool: call.name,
          server: entry.serverName,
          ok: !output.isError,
        }),
        toolMessage: { role: 'tool', toolCallId: call.id, content: text },
      });
    } catch (error) {
      // Redact like the success path: a server's error string could echo back
      // arguments the model placed there (which may include a secret).
      const message = redactSecrets(
        `MCP call failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      events.push({
        event: emit('tool_call', { tool: call.name, server: entry.serverName, error: message }),
        toolMessage: { role: 'tool', toolCallId: call.id, content: message },
      });
    }
    return events;
  }

  /**
   * Resolves whether a tool requires confirmation, consulting the path/command
   * gate for the path/command tools and the generic tool flag otherwise.
   */
  private confirmationGate(
    permissions: PermissionEngine,
    name: NativeToolName,
    args: Record<string, unknown>,
    config: ExcaliburConfig,
  ): { allowed: boolean; requiresConfirmation: boolean; reason: string } {
    const pass = (d: {
      allowed: boolean;
      requiresConfirmation: boolean;
      reason: string;
    }): {
      allowed: boolean;
      requiresConfirmation: boolean;
      reason: string;
    } => ({ allowed: d.allowed, requiresConfirmation: d.requiresConfirmation, reason: d.reason });
    if (name === 'update_tasks') {
      // The checklist is pure declaration — never gated.
      return {
        allowed: true,
        requiresConfirmation: false,
        reason: 'checklist update (no side effect)',
      };
    }
    if (name === 'write_file') {
      return pass(permissions.checkPath(String(args['path'] ?? ''), 'write'));
    }
    if (name === 'read_file' || name === 'list_files') {
      return pass(permissions.checkPath(String(args['path'] ?? '.'), 'read'));
    }
    if (name === 'run_command') {
      return pass(permissions.checkCommand(String(args['command'] ?? '')));
    }
    if (name === 'web_fetch') {
      // SSRF + network policy: a private/metadata target is a HARD deny here.
      return pass(permissions.checkUrl(String(args['url'] ?? '')));
    }
    if (name === 'web_search') {
      // The concrete provider host is resolved at exec time; gate on the policy
      // (lockdown denies; ask/auto decides confirmation). Per-host SSRF/allowlist
      // is enforced inside the executor on the chosen provider URL.
      return pass(permissions.checkNetwork());
    }
    if (name === 'run_tests') {
      // Gate the EXACT command the executor will run (base + pattern), not just
      // the base — otherwise the user approves `npm test` while the shell runs
      // `npm test <model-controlled pattern>`.
      const base = (args['command'] as string | undefined) ?? config.commands?.test ?? 'npm test';
      const pattern = args['pattern'] as string | undefined;
      const command = pattern !== undefined ? `${base} ${pattern}` : base;
      return pass(permissions.checkCommand(command));
    }
    // apply_patch / create_branch / git_diff / search_code use the tool flag.
    return pass(permissions.checkTool(name));
  }

  /**
   * For implementer turns whose loop mutated the tree, emits `patch_generated`
   * carrying the REAL `git diff` so `execute-local-run` can collect/apply it.
   * No-op when nothing was mutated or the workdir is not a git repo.
   *
   * Newly created files are untracked and would not appear in a plain `git
   * diff`, so the mutated paths are first staged with `--intent-to-add` (a
   * non-destructive marker that makes new files visible in the diff without
   * actually staging their content). The intent-to-add marks are reset
   * afterwards to leave the index untouched.
   */
  private async maybeEmitPatch(
    input: AgentRunInput,
    mutated: Set<string>,
    emit: (type: ExcaliburEventType, payload: Record<string, unknown>) => ExcaliburEvent,
  ): Promise<ExcaliburEvent[]> {
    if (input.role !== 'implementer' || mutated.size === 0) {
      return [];
    }
    const paths = [...mutated].sort();
    const runGit = async (args: string[]): Promise<string | null> => {
      try {
        const { stdout } = await execFileAsync('git', args, {
          cwd: input.workdir,
          maxBuffer: 8 * 1024 * 1024,
        });
        return stdout;
      } catch {
        return null;
      }
    };

    // Surface new (untracked) files in the diff without staging their content.
    await runGit(['add', '--intent-to-add', '--', ...paths]);
    const diff = (await runGit(['diff', '--no-color'])) ?? '';
    // Reset the intent-to-add marks so the index is left exactly as it was.
    await runGit(['reset', '-q', '--', ...paths]);

    if (diff.trim().length === 0) {
      return [
        emit('patch_generated', {
          diff: '',
          filesAffected: paths,
          note: 'Working-tree changes captured via file_write events (no git diff available).',
        }),
      ];
    }
    return [
      emit('patch_generated', {
        diff: redactSecrets(diff),
        filesAffected: filesAffectedFromDiff(diff),
      }),
    ];
  }
}

// --- helpers ----------------------------------------------------------------

/** Max diagnostics shown to the model per edited file (the rest are summarized). */
const MAX_DIAGNOSTICS_SHOWN = 20;

/**
 * Formats a file's diagnostics as a compact, model-facing block appended to the
 * edit's tool result — only errors/warnings (info/hint are noise), capped, so
 * the agent anchors its next turn on REAL compiler output, not invented errors.
 */
function formatDiagnosticsForModel(diag: DiagnosticsPayload): string {
  const surfaced = diag.diagnostics.filter(
    (d) => d.severity === 'error' || d.severity === 'warning',
  );
  if (surfaced.length === 0) {
    return '';
  }
  const lines = surfaced
    .slice(0, MAX_DIAGNOSTICS_SHOWN)
    .map(
      (d) =>
        `  ${diag.file}:${d.line}:${d.column} ${d.severity}: ${d.message}${d.code !== undefined ? ` [${d.code}]` : ''}`,
    );
  const more =
    surfaced.length > MAX_DIAGNOSTICS_SHOWN
      ? `\n  …(+${surfaced.length - MAX_DIAGNOSTICS_SHOWN} more)`
      : '';
  return `Compiler diagnostics (LSP) — fix these real errors, do not invent others:\n${lines.join('\n')}${more}\n`;
}

/** Reads `+++ b/<path>` lines from a unified diff. */
function filesAffectedFromDiff(diff: string): string[] {
  const affected: string[] = [];
  for (const line of diff.split('\n')) {
    const match = /^\+\+\+ b\/(.+)$/.exec(line);
    const path = match?.[1]?.trim();
    if (path !== undefined && path.length > 0 && !affected.includes(path)) {
      affected.push(path);
    }
  }
  return affected;
}

/** Extracts the repository-relative path arg a tool operates on, if any. */
function pathArgOf(name: NativeToolName, args: Record<string, unknown>): string | undefined {
  if (name === 'read_file' || name === 'write_file' || name === 'list_files') {
    const value = args['path'];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

/** Builds the event payload for a tool result (redacted, never raw secrets). */
function toolEventPayload(
  name: NativeToolName,
  args: Record<string, unknown>,
  ok: boolean,
  result: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = { tool: name, ok };
  const path = pathArgOf(name, args);
  if (path !== undefined) {
    base['path'] = path;
  }
  if (name === 'write_file') {
    base['operation'] = ok ? 'modify' : 'rejected';
  }
  if (name === 'run_command' || name === 'run_tests') {
    const command =
      (args['command'] as string | undefined) ?? (name === 'run_tests' ? '(detected test)' : '');
    base['command'] = command;
    base['exitCode'] = ok ? 0 : 1;
    // A PERMISSION-DENIED command never ran → flag it `denied` so downstream
    // consumers (e.g. the claim ledger) don't read exit 1 as a real failure.
    if (!ok && /^permission denied/i.test(result.trim())) {
      base['denied'] = true;
    }
  }
  if (name === 'create_branch') {
    base['branch'] = String(args['name'] ?? '');
  }
  if (name === 'web_fetch') {
    base['url'] = String(args['url'] ?? '');
    if (!ok && /^permission denied/i.test(result.trim())) {
      base['denied'] = true;
    }
  }
  if (name === 'web_search') {
    base['query'] = String(args['query'] ?? '');
    if (!ok && /^permission denied/i.test(result.trim())) {
      base['denied'] = true;
    }
  }
  if (name === 'apply_patch') {
    base['simulated'] = false;
  }
  if (name === 'update_tasks') {
    // Surface the checklist SNAPSHOT as the `task_update` payload; the reducer
    // keys items by their (synthesized, stable-by-index) id.
    const raw = Array.isArray(args['tasks']) ? (args['tasks'] as unknown[]) : [];
    base['tasks'] = raw.map((item, index) => {
      const t = (item ?? {}) as { text?: unknown; status?: unknown };
      return {
        id: `task-${index + 1}`,
        text: typeof t.text === 'string' ? t.text : '',
        status: t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending',
      };
    });
  }
  // The (already-redacted) result text rides along, capped for event hygiene.
  base['result'] = result.length > 4000 ? `${result.slice(0, 4000)}…` : result;
  return base;
}

/** Redacts tool-call arguments before they enter an event payload. */
function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = typeof value === 'string' ? redactSecrets(value) : value;
  }
  return out;
}

/** Short human-readable detail for a confirmation request. */
function describeCall(name: NativeToolName, args: Record<string, unknown>): string | undefined {
  if (name === 'write_file' || name === 'read_file' || name === 'list_files') {
    return typeof args['path'] === 'string' ? `path: ${args['path']}` : undefined;
  }
  if (name === 'run_command') {
    return typeof args['command'] === 'string' ? `command: ${args['command']}` : undefined;
  }
  if (name === 'run_tests') {
    return typeof args['command'] === 'string'
      ? `command: ${args['command']}`
      : 'detected test command';
  }
  if (name === 'create_branch') {
    return typeof args['name'] === 'string' ? `branch: ${args['name']}` : undefined;
  }
  if (name === 'web_fetch') {
    return typeof args['url'] === 'string' ? `url: ${args['url']}` : undefined;
  }
  if (name === 'web_search') {
    return typeof args['query'] === 'string' ? `query: ${args['query']}` : undefined;
  }
  return undefined;
}
