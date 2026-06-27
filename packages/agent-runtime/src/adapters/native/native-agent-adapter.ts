import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  createEvent,
  DEFAULT_BLOCKED_PATHS,
  DEFAULT_LSP_CONFIG,
  type AgentRole,
  type DiagnosticsPayload,
  type ExcaliburConfig,
  type ExcaliburEvent,
  type ExcaliburEventType,
} from '@excalibur/shared';
import { estimateTokens, redactSecrets } from '@excalibur/model-gateway';
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
import { formatFile } from '../../tools/formatters';
import {
  extensionToolSpecs,
  extensionToolsByName,
  type ExtensionTool,
  type ExtensionToolContext,
  type ExtensionToolLogger,
} from '../../tools/extension-tools';
import {
  executeNativeTool,
  isOutsideWorkdir,
  type ToolExecutionContext,
} from '../../tools/execute-tool';
import { loadSkillIndex, type SkillEntry } from '../../tools/skills-reader';
import { resolveLocalSearxng } from '../../tools/web/searxng-manager';
import { browserReaderFrom } from '../../tools/web/browser-fetch';
import { WebCache } from '../../tools/web/cache';
import { RateLimiter } from '../../tools/web/polite-fetch';
import { PermissionEngine } from '../../permissions/permission-engine';
import { createLspSession, languageForFile, type LspSession } from '../../lsp';
import {
  asJsonObject,
  closeMcp,
  connectMcpServers,
  mcpResultToText,
  type ConnectedMcp,
  type McpServerSpec,
  type McpToolEntry,
} from '../../mcp/mcp-tools';
import { scanMcpOutput } from '../../mcp/injection-scan';
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

/** Native tools that make an outbound network call (F8: audited via network_egress). */
const NETWORK_TOOL_NAMES: ReadonlySet<NativeToolName> = new Set<NativeToolName>([
  'web_fetch',
  'web_search',
  'web_extract',
  'web_crawl',
  'research',
]);

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
  // Structured extraction + bounded crawl are read-only research (no mutation).
  'web_extract',
  'web_crawl',
  // Deep research (search + fetch + cite) is pure read-only discovery.
  'research',
  // Code intelligence (definition/references/hover) is read-only navigation.
  'lsp',
  // Asking the human a clarifying question mutates nothing.
  'question',
  // Loading a skill's instructions is read-only progressive disclosure.
  'skill',
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
    case 'edit':
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
    case 'web_extract':
    case 'web_crawl':
    case 'research':
    case 'lsp':
    case 'question':
    case 'skill':
      return 'tool_call';
  }
}

/**
 * Merges a custom agent's permission overrides OVER the project permissions
 * (P1.7). Per-tool flags merge object-wise; `allowedCommands`/`network` are
 * replaced when the agent specifies them; the DENY lists (`deniedCommands`,
 * `blockedPaths`) are UNIONED — an agent can only tighten, never lift a denial
 * the project set (deny always wins). Returns the base untouched when there is
 * no override.
 */
function mergeAgentPermissions(
  base: ExcaliburConfig['permissions'],
  override: ExcaliburConfig['permissions'],
): ExcaliburConfig['permissions'] {
  if (override === undefined) {
    return base;
  }
  const merged: NonNullable<ExcaliburConfig['permissions']> = { ...base, ...override };
  if (base?.tools !== undefined || override.tools !== undefined) {
    merged.tools = { ...base?.tools, ...override.tools };
  }
  if (override.deniedCommands !== undefined) {
    merged.deniedCommands = [...(base?.deniedCommands ?? []), ...override.deniedCommands];
  }
  if (override.blockedPaths !== undefined) {
    // Union with the project's blocked paths (or the safe defaults the engine
    // would otherwise apply) so an agent's list never DROPS a project denial.
    merged.blockedPaths = [
      ...(base?.blockedPaths ?? DEFAULT_BLOCKED_PATHS),
      ...override.blockedPaths,
    ];
  }
  return merged;
}

/** Builds the JSON-Schema tool specs the gateway sends to the model. */
function toolSpecsFor(role: AgentRole, allowedTools?: ReadonlyArray<string>): ToolSpec[] {
  const base: ReadonlyArray<NativeToolName> = READ_ONLY_ROLES.has(role)
    ? READ_ONLY_TOOLS
    : NATIVE_TOOL_NAMES;
  // A custom agent's `tools:` allowlist can only NARROW the role's floor (it
  // intersects — a read-only role can never be widened to mutate). Names that
  // aren't native tools simply don't match and are dropped.
  const allowed: ReadonlyArray<NativeToolName> =
    allowedTools !== undefined ? base.filter((name) => allowedTools.includes(name)) : base;
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

/**
 * The default engineering bar — the standards a senior engineer applies to ANY
 * development task, so the agent ships production-quality work by default instead
 * of a throwaway (the gap that produced a bare inline `index.html` with no
 * structure and no verification). Deliberately GENERAL: no per-stack or per-task
 * rules, just how to build well whatever the task. Skipped for read-only roles
 * (planners, reviewers, researchers), which observe rather than build.
 */
function engineeringGuidance(role: AgentRole): string[] {
  if (READ_ONLY_ROLES.has(role)) {
    return [];
  }
  return [
    'Work to a professional, production-quality bar on EVERY task, however small —',
    'never a throwaway or a quick hack.',
    'Structure the work properly: use a sensible project and file layout and separate',
    'concerns into their own files and modules (styles, scripts, assets, components,',
    'config) instead of cramming everything into one monolithic file. Follow the',
    'conventions and idioms of the language and framework, and — in an existing repo —',
    'the surrounding code. Write clear, maintainable code with real error handling and',
    'good names; no dead code or copy-paste filler.',
    'Design for the people who use it: usability and accessibility for the end user,',
    'and developer experience (easy to read, run, and extend) for whoever comes next.',
    'VERIFY before declaring done: build it, run the tests and any linters/formatters,',
    'and for anything runnable (an app, a site, a server, a script) actually run or',
    'serve it and confirm it works — do not just write files and stop. Leaving a dev',
    'server or watcher running in the background to verify is fine; it is not a failure.',
    'If doing it right needs missing pieces (a build step, config, a folder, a',
    'dependency), create them rather than cutting corners to finish faster.',
  ];
}

function systemPromptFor(input: AgentRunInput): string {
  const phase =
    input.phase !== undefined ? ` for phase "${input.phase.name}" (${input.phase.type})` : '';
  // A custom agent (P1.7) supplies its own persona, used in place of the default
  // role header. The operational protocol below still applies so the agent never
  // loses the tool-use contract (workdir, tool authority, `update_tasks`).
  const persona = input.systemPrompt?.trim();
  const header =
    persona !== undefined && persona.length > 0
      ? persona
      : `You are the Excalibur native agent acting as the "${input.role}" role${phase}.`;
  return [
    header,
    ...adversarialPreamble(input.role),
    `Working directory: ${input.workdir}.`,
    'You can call the provided tools to read and change the repository. You are NOT',
    'confined to the working directory: an absolute path or a `../sibling/…` path',
    'works for reading AND writing, so you can review or modify another project the',
    'user points you at. (Writing outside the working directory asks the user to',
    'confirm first — that is expected; proceed when approved.) Tool results are',
    'authoritative — obey them and adapt when a tool reports an error or a',
    'permission denial.',
    'For any task with more than one step, FIRST call `update_tasks` with the full',
    'checklist (each step as a separate item), then keep it current as you work:',
    'mark exactly one item "in_progress", flip finished items to "completed", and',
    'send the whole list again each time. It is shown to the user as a live to-do',
    'list. Skip it only for trivial one-step tasks.',
    ...engineeringGuidance(input.role),
    ...narrationGuidance(input.role),
    'When the task is complete, reply with a brief, warm summary — like updating a',
    'teammate on what you did and why — and no further tool calls.',
  ].join('\n');
}

/**
 * Voice & narration — the conversational layer that makes a run feel like a real
 * pair-programmer thinking out loud, not a mechanical tool log. The model's prose
 * that accompanies a tool call is surfaced to the user live (before the action),
 * so this guidance shapes what they actually read between steps.
 *
 * Two deliberate dials (per the product decision): a WARM, first-person voice,
 * and KEY-MOMENT density — talk when it adds something, stay quiet on routine
 * steps so it never feels chatty. Adversarial reviewer roles keep their strict
 * issue-list output for the FINAL answer; this only governs the interstitial
 * narration, so the two coexist.
 */
function narrationGuidance(_role: AgentRole): string[] {
  return [
    'Narrate your work continuously, like a friendly pair-programmer thinking out',
    'loud, so the user is NEVER left watching a silent cursor. Open every turn with',
    'one short sentence about what you are doing right now (e.g. "Let me understand',
    'what you are asking…" / "Checking how this part of the code works…"). Before',
    'each meaningful action — reading or changing files, running a command, launching',
    'sub-agents — say in one short, plain-language sentence what you are about to do',
    'and why; after a key finding or decision, say what you learned and what it',
    'changes. Keep each note to a sentence or two, warm and free of internal jargon,',
    'and never restate raw tool output the user already sees.',
    'Call the unit of work a "task" (Spanish: "tarea"). NEVER call it a "run" or an',
    '"ejecución" — say "work on the task" / "trabajar en la tarea", never "start a run".',
    'Write this narration in the SAME language the user used.',
  ];
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
  /** The native adapter's capabilities are exactly its native tool names. */
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

    // A custom agent (P1.7) may carry its own permission overrides; merge them
    // over the project's (deny lists union — the agent can only tighten).
    const permissions = new PermissionEngine(
      mergeAgentPermissions(input.config.permissions, input.permissions),
    );
    const searchCfg = input.config.search;
    const browserCfg = input.config.browser;
    const crawlCfg = input.config.crawl;
    // Skill index for the `skill` tool (P1.8b): scan the PROJECT for SKILL.md
    // files once per run (cheap, bounded). Their names+descriptions are surfaced
    // in the system prompt; the model pulls a body on demand by name. Project
    // scope only — we deliberately do NOT scan ~/.claude/skills etc. so an
    // Excalibur run never silently inherits another tool's global skills.
    const skillIndex: SkillEntry[] = loadSkillIndex([input.workdir]);
    const toolCtx: ToolExecutionContext = {
      workdir: input.workdir,
      config: input.config,
      permissions,
      // The skill index (empty → the `skill` tool reports none available).
      ...(skillIndex.length > 0 ? { skills: skillIndex } : {}),
      // Skill-disclosure policy (P2.18): in 'approved' mode the `skill` tool
      // withholds the body of any skill not on the approved list.
      ...(input.config.skills?.approval !== undefined
        ? { skillApproval: input.config.skills.approval }
        : {}),
      ...(input.config.skills?.approved !== undefined
        ? { approvedSkills: input.config.skills.approved }
        : {}),
      // Thread the run's abort signal so ESC/abort SIGKILLs an in-flight
      // command/test/git process instead of waiting for it to finish.
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      // Free-text human channel for the `question` tool (P1.8b). Absent →
      // the tool tells the model to proceed autonomously.
      ...(input.ask !== undefined ? { ask: input.ask } : {}),
      // web_search: resolve a reachable local SearXNG (probe, and start an
      // existing stopped container when managed) — else null → DuckDuckGo.
      searchEnv: process.env,
      scrapeEnv: process.env,
      resolveSearxng: () =>
        resolveLocalSearxng({
          autoStart: searchCfg?.manageSearxng ?? true,
          ...(searchCfg?.baseUrl !== undefined ? { baseUrl: searchCfg.baseUrl } : {}),
        }),
      // web_extract's keyless LLM pass uses the same gateway/model as the loop.
      gateway: input.gateway,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      // web_crawl: one shared cache + rate limiter for the whole run, so a
      // multi-page crawl reuses cached pages and spaces requests per host.
      webCache: new WebCache(
        crawlCfg !== undefined
          ? { ttlMs: crawlCfg.cacheTtlMs, maxEntries: crawlCfg.cacheMaxEntries }
          : {},
      ),
      rateLimiter: new RateLimiter(),
      // Tier-2 browser reader, only when the user opted in (F4). Absent → Tier-1.
      ...(browserCfg?.enabled === true
        ? {
            browserReader: browserReaderFrom({
              command: browserCfg.command,
              args: browserCfg.args,
              timeoutMs: browserCfg.timeoutMs,
            }),
          }
        : {}),
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
    // Auto-install progress (P1.10b) is produced lazily during a later tool call,
    // where we can't yield directly — buffer here and drain into events after the
    // diagnostics pass that triggers the install.
    const lspLogs: string[] = [];
    const responseKind = ROLE_TO_RESPONSE_KIND[input.role] ?? 'ask';
    const mutated = new Set<string>();
    const totals: RunningTotals = { inputTokens: 0, outputTokens: 0, costCents: null };

    // Fork-from-cache (T2): when a cached prefix is supplied, replay the source
    // run's reconstructed turns as context ahead of the new instruction — zero
    // tokens re-spent on the prefix, only `input.prompt` runs live. The system
    // prompt is always freshly built for THIS run's role/workdir/phase.
    // Progressive disclosure (P1.8b): tell the model WHICH skills exist (names +
    // one-line descriptions) so it knows to pull a relevant one via the `skill`
    // tool — without spending their full bodies on every prompt.
    const skillsHint =
      skillIndex.length > 0
        ? `\n\nAvailable skills (load full instructions on demand with the \`skill\` tool when relevant):\n${skillIndex
            .map((s) => `- ${s.name}: ${s.description}`)
            .join('\n')}`
        : '';
    const systemContent = systemPromptFor(input) + skillsHint;
    const messages: ChatMessage[] =
      input.seedMessages !== undefined && input.seedMessages.length > 0
        ? [
            { role: 'system', content: systemContent },
            ...input.seedMessages,
            { role: 'user', content: input.prompt },
          ]
        : [
            { role: 'system', content: systemContent },
            { role: 'user', content: input.prompt },
          ];

    const aborted = (): boolean =>
      input.signal?.aborted === true || this.stoppedSessions.has(input.sessionId);

    let wasAborted = false;
    let wasErrored = false;
    let finalContent = '';

    try {
      // Connect MCP servers for EVERY role (F6): read-only/research roles now get
      // MCP too, but only a server's NON-MUTATING tools (the policy hides mutating
      // ones), and the per-server egress sandbox + SSRF floor gate remote
      // endpoints. A server that fails/declines is skipped with a warning; MCP
      // never breaks the run.
      const mcpServers = input.config.mcp?.servers;
      if (mcpServers !== undefined && Object.keys(mcpServers).length > 0) {
        mcp = await connectMcpServers(mcpServers as Record<string, McpServerSpec>, {
          isReadOnlyRole: READ_ONLY_ROLES.has(input.role),
          engine: permissions,
          env: process.env,
        });
      }
      for (const warning of mcp.warnings) {
        yield emit('policy_decision', { kind: 'log', decision: 'allow', message: warning });
      }
      // Every role gets an LSP session when enabled: editing roles use it for
      // per-edit diagnostics, and ALL roles (incl. read-only reviewers) can use
      // the model-callable `lsp` tool (P1.8b) for definition/references/hover.
      // It is lazy — no server spawns until the first edit/query of an installed
      // language — so creating it for read-only roles costs nothing unused.
      const lspCfg = input.config.lsp;
      if (lspCfg?.enabled ?? true) {
        lsp = createLspSession({
          workdir: input.workdir,
          config: lspCfg ?? DEFAULT_LSP_CONFIG,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          onLog: (message) => lspLogs.push(message),
        });
        // Expose the session to the `lsp` tool executor via the shared tool ctx.
        toolCtx.lsp = lsp;
      }
      // Extension-contributed tools (extensions-spec.md §5): advertised to the
      // model alongside native + MCP tools, dispatched through their own
      // execute() below. Read-only roles only see tools that opted in via
      // `readOnly`. A name clash with a native/MCP tool is resolved native-first
      // (the dispatch checks MCP, then native, then extension), so extensions
      // cannot shadow a built-in tool.
      const extensionTools: ReadonlyArray<ExtensionTool> = input.extensionTools ?? [];
      const extByName = extensionToolsByName(extensionTools);
      const tools = [
        ...toolSpecsFor(input.role, input.allowedTools),
        ...mcp.specs,
        ...extensionToolSpecs(extensionTools, { readOnlyRole: READ_ONLY_ROLES.has(input.role) }),
      ];

      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
        if (aborted()) {
          wasAborted = true;
          break;
        }

        // IN-TURN compaction: keep a long agentic turn within the context window.
        // Best-effort — the compactor returns a provider-VALID (tool-call paired)
        // array, or null to leave it unchanged; a failure never breaks the loop.
        if (input.compactContext !== undefined) {
          try {
            const compacted = await input.compactContext(messages);
            if (compacted !== null) {
              const before = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
              messages.length = 0;
              messages.push(...compacted);
              const after = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
              if (after < before) {
                yield emit('compaction', { before, after, scope: 'in-turn' });
              }
            }
          } catch {
            // compaction is best-effort; never break the loop on it.
          }
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
        // A custom agent's sampling temperature (P1.7), when set.
        if (input.temperature !== undefined) {
          chatInput.temperature = input.temperature;
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
          // Stream the turn when a live narration sink is present AND the gateway
          // can stream tool-call-bearing turns — the model's prose types out as it
          // arrives. `streamChat` returns the SAME complete output as `chat` (and
          // itself falls back to a non-streamed call for providers that cannot
          // stream tool calls), so the loop is identical downstream. Without a sink
          // (or on a fake/narrow gateway) it is a plain `chat`.
          const gateway = input.gateway;
          if (input.onNarration !== undefined && typeof gateway.streamChat === 'function') {
            const sink = input.onNarration;
            let acc = '';
            output = await gateway.streamChat(chatInput, (delta) => {
              acc += delta;
              sink({ delta, content: acc });
            });
          } else {
            output = await gateway.chat(chatInput);
          }
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
            extByName,
            lsp,
            lspLogs,
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
    extByName: ReadonlyMap<string, ExtensionTool>,
    lsp: LspSession | null,
    lspLogs: string[],
  ): Promise<Array<{ event: ExcaliburEvent; toolMessage?: ChatMessage }>> {
    const events: Array<{ event: ExcaliburEvent; toolMessage?: ChatMessage }> = [];

    // MCP tool (namespaced `mcp__<server>__<tool>`) → route to its server,
    // gated by confirmation (external tools always require approval).
    const mcpEntry = mcpByName.get(call.name);
    if (mcpEntry !== undefined) {
      return this.runMcpToolCall(input, call, mcpEntry, emit);
    }

    // Extension-contributed tool → dispatch through its own execute(). Checked
    // AFTER MCP/native names so an extension can never shadow a built-in tool.
    const extTool = extByName.get(call.name);
    if (extTool !== undefined && !isNativeToolName(call.name)) {
      return this.runExtensionToolCall(input, ctx, call, extTool, emit);
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
    const gate = this.confirmationGate(
      ctx.permissions,
      toolName,
      call.arguments,
      ctx.config,
      ctx.workdir,
    );
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

    const { ok, result, provenance } = await executeNativeTool(toolName, call.arguments, ctx);

    // F8: audit the egress itself (host/query + policy decision) for every web
    // tool — complements `provenance` (which audits the content), and covers
    // searches + denied attempts that fetch no content.
    if (NETWORK_TOOL_NAMES.has(toolName)) {
      const target = String(
        call.arguments['url'] ?? call.arguments['query'] ?? call.arguments['question'] ?? '',
      );
      const denied = !ok && /^permission denied/i.test(result.trim());
      events.push({
        event: emit('network_egress', {
          tool: toolName,
          target,
          decision: denied ? 'deny' : 'allow',
        }),
      });
    }

    // F8: audit untrusted inbound web content — emit a `provenance` event with the
    // source, content hash and injection verdict (clean/suspicious/malicious).
    if (provenance !== undefined) {
      events.push({
        event: emit('provenance', provenance as unknown as Record<string, unknown>),
      });
      if (provenance.verdict === 'malicious') {
        events.push({
          event: emit('policy_decision', {
            kind: 'injection',
            tool: toolName,
            decision: provenance.blocked ? 'deny' : 'allow',
            message: `Untrusted ${provenance.source} content flagged malicious (${provenance.signals.join(', ')})`,
          }),
        });
      }
    }

    // The files THIS call just edited (the per-call delta) — used both to grow
    // the run-wide `mutated` set and to scope the per-edit LSP diagnostics query.
    const editedNow: string[] = [];
    if (ok) {
      const target = pathArgOf(toolName, call.arguments);
      if (
        target !== undefined &&
        (toolName === 'write_file' || toolName === 'edit' || toolName === 'apply_patch')
      ) {
        editedNow.push(target);
      }
      if (toolName === 'apply_patch') {
        editedNow.push(...filesAffectedFromDiff(String(call.arguments['diff'] ?? '')));
      }
      for (const path of editedNow) {
        mutated.add(path);
      }
    }

    // Per-edit formatters (P1.9): format each just-edited file with its language
    // formatter when one is available (prettier/gofmt/rustfmt/black). Best-effort
    // and confined to the workdir; a missing/failing formatter never breaks the run.
    if ((ctx.config.format?.enabled ?? true) && editedNow.length > 0) {
      for (const rel of [...new Set(editedNow)]) {
        try {
          const result = await formatFile(join(ctx.workdir, rel), { workdir: ctx.workdir });
          if (result.formatted) {
            events.push({
              event: emit('policy_decision', {
                kind: 'log',
                decision: 'allow',
                tool: toolName,
                message: `formatted ${rel} with ${result.formatter}`,
              }),
            });
          }
        } catch {
          /* formatting is best-effort — never break the run */
        }
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
    // Surface any auto-install progress produced while starting servers above.
    while (lspLogs.length > 0) {
      const message = lspLogs.shift();
      if (message !== undefined) {
        events.push({
          event: emit('policy_decision', { kind: 'log', decision: 'allow', message }),
        });
      }
    }

    // CC-parity inline diff (AO6 Pillar 1): for a file-mutating edit, capture
    // the per-edit unified diff of the just-written file(s) — AFTER any formatter
    // ran above, so it reflects the final on-disk content — and carry it on the
    // `file_write` event. The live rail then streams the highlighted diff inline
    // (collapsible, Space to expand) right after the write line. Best-effort.
    let editDiff = '';
    if (ok && editedNow.length > 0 && (toolName === 'write_file' || toolName === 'edit')) {
      editDiff = await diffForEditedPaths(ctx.workdir, editedNow);
    }

    const eventType = eventTypeForTool(toolName);
    const payload = toolEventPayload(toolName, call.arguments, ok, result);
    if (editDiff.length > 0) {
      payload['diff'] = editDiff;
    }
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

    // Defense in depth (F6): a mutating MCP tool is HARD-DENIED for a read-only
    // role even if it somehow reached here (the policy already hides them).
    if (entry.access === 'mutate' && READ_ONLY_ROLES.has(input.role)) {
      const result = `denied: mutating MCP tool "${entry.toolName}" is not available to a read-only role`;
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

    const reason = `external MCP tool "${entry.toolName}" (server: ${entry.serverName})`;
    // A `trusted` server skips the per-call confirmation (its output is STILL
    // injection-scanned below). Otherwise external tools always require approval.
    const approved =
      entry.trust === 'trusted'
        ? true
        : input.confirm !== undefined
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

    const injectionMode = input.config.mcp?.injectionScan ?? 'warn';
    try {
      const output = await entry.client.callTool(entry.toolName, asJsonObject(call.arguments));
      // Scan the UNTRUSTED result for prompt-injection BEFORE it enters context,
      // then redact secrets. A flagged result is fenced (warn) or withheld (strict).
      const scan = scanMcpOutput(mcpResultToText(output), entry.serverName, injectionMode);
      const text = redactSecrets(scan.text);
      if (scan.flagged) {
        events.push({
          event: emit('policy_decision', {
            kind: 'injection',
            tool: call.name,
            server: entry.serverName,
            decision: injectionMode === 'strict' && scan.verdict === 'malicious' ? 'deny' : 'allow',
            message: `MCP output flagged (${scan.signals.map((s) => s.category).join(', ')})`,
          }),
        });
      }
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
   * Executes one extension-contributed tool (extensions-spec.md §5): announce →
   * gate through the PermissionEngine (`checkTool` defaults unknown/extension
   * tools to `ask`, so a third-party tool requires confirmation unless the user
   * pre-allowed it via `permissions.tools[<name>] = true`) → confirm-or-decline
   * → run the tool's own `execute()` inside a try/catch. The tool's logger calls
   * surface as `log` events; the result text (redacted) becomes the model's tool
   * message. An exception is reported as a tool result, never thrown — a faulty
   * extension can never crash the run.
   */
  private async runExtensionToolCall(
    input: AgentRunInput,
    ctx: ToolExecutionContext,
    call: ToolCall,
    tool: ExtensionTool,
    emit: (type: ExcaliburEventType, payload: Record<string, unknown>) => ExcaliburEvent,
  ): Promise<Array<{ event: ExcaliburEvent; toolMessage?: ChatMessage }>> {
    const events: Array<{ event: ExcaliburEvent; toolMessage?: ChatMessage }> = [];
    events.push({
      event: emit('tool_call', {
        tool: call.name,
        extension: true,
        arguments: redactArgs(call.arguments),
      }),
    });

    // Extension tools follow the generic tool flag: unknown names default to
    // `ask` (PermissionEngine.UNKNOWN_TOOL_FLAG), so third-party code is gated
    // conservatively unless the user explicitly set it `true`.
    const gate = ctx.permissions.checkTool(call.name);
    if (!gate.allowed) {
      const result = `denied: ${gate.reason}`;
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
    if (gate.requiresConfirmation) {
      const reason = `extension tool "${call.name}"`;
      const approved =
        input.confirm !== undefined
          ? await input.confirm({ tool: call.name, reason, detail: tool.description })
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
    }

    // Capture the tool's logger output so it is auditable on the event stream
    // (packages never print; the host decides how to surface log events).
    const logs: string[] = [];
    const logger: ExtensionToolLogger = {
      info: (msg) => logs.push(`[info] ${msg}`),
      warn: (msg) => logs.push(`[warn] ${msg}`),
      error: (msg) => logs.push(`[error] ${msg}`),
    };
    const toolContext: ExtensionToolContext = {
      workdir: input.workdir,
      runId: input.runId,
      sessionId: input.sessionId,
      role: input.role,
      config: input.config,
      logger,
    };

    let ok: boolean;
    let content: string;
    try {
      const result = await tool.execute(call.arguments, toolContext);
      ok = result.success === true;
      const body = ok
        ? result.output
        : (result.error ?? result.output ?? 'extension tool reported failure');
      content = redactSecrets(typeof body === 'string' ? body : String(body));
    } catch (error) {
      ok = false;
      content = redactSecrets(
        `extension tool "${call.name}" threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    for (const line of logs) {
      events.push({
        event: emit('policy_decision', {
          kind: 'log',
          decision: 'allow',
          tool: call.name,
          message: redactSecrets(line),
        }),
      });
    }

    events.push({
      event: emit('tool_call', {
        tool: call.name,
        extension: true,
        ok,
        result: content.length > 4000 ? `${content.slice(0, 4000)}…` : content,
      }),
      toolMessage: { role: 'tool', toolCallId: call.id, content },
    });
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
    workdir: string,
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
    if (name === 'write_file' || name === 'edit') {
      const p = String(args['path'] ?? '');
      const decision = permissions.checkPath(p, 'write');
      // A write OUTSIDE the working directory is allowed but ALWAYS confirmed: the
      // agent can change a sibling project when asked, but never silently leaves
      // the working directory (under auto-accept the confirmer decides).
      if (decision.allowed && isOutsideWorkdir(workdir, p)) {
        return {
          allowed: true,
          requiresConfirmation: true,
          reason: `Writing outside the working directory: "${p}".`,
        };
      }
      return pass(decision);
    }
    if (name === 'read_file' || name === 'list_files') {
      return pass(permissions.checkPath(String(args['path'] ?? '.'), 'read'));
    }
    if (name === 'lsp') {
      // Read-only code intelligence — gate like a file read on the queried path.
      return pass(permissions.checkPath(String(args['path'] ?? '.'), 'read'));
    }
    if (name === 'question') {
      // Asking the human IS the interaction — never gate it behind a confirm.
      return {
        allowed: true,
        requiresConfirmation: false,
        reason: 'clarifying question (no side effect)',
      };
    }
    if (name === 'skill') {
      // Loading skill instructions is read-only progressive disclosure.
      return {
        allowed: true,
        requiresConfirmation: false,
        reason: 'skill load (read-only)',
      };
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
    if (name === 'web_extract') {
      // Single concrete URL → SSRF/allowlist gate like web_fetch.
      return pass(permissions.checkUrl(String(args['url'] ?? '')));
    }
    if (name === 'web_crawl' || name === 'research') {
      // Many URLs resolved while crawling/researching; gate on the policy here,
      // each page is SSRF/allowlist-checked inside the executor before it is fetched.
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
/** Beyond this, the inline per-edit diff is truncated (the live DiffView caps display independently). */
const MAX_INLINE_DIFF_LINES = 400;

/** Line-caps a per-edit diff so a huge write can't bloat `events.jsonl`. */
function capInlineDiff(diff: string): string {
  if (diff.trim().length === 0) return '';
  const lines = diff.split('\n');
  if (lines.length <= MAX_INLINE_DIFF_LINES) return diff;
  const head = lines.slice(0, MAX_INLINE_DIFF_LINES);
  head.push(`… (+${lines.length - MAX_INLINE_DIFF_LINES} more diff lines truncated)`);
  return head.join('\n');
}

/**
 * Best-effort per-edit unified diff for the just-written files (AO6 Pillar 1) —
 * the source of the inline highlighted diff streamed in the live rail right
 * after each write (CC-parity). Mirrors {@link NativeAgentAdapter.maybeEmitPatch}'s
 * git approach: `--intent-to-add` so newly-created files appear in the diff,
 * diff ONLY the given paths, then reset the index so nothing is left staged.
 * Returns '' when the workdir is not a git repo, no change is visible, or git
 * fails — the write line then renders with no diff (the activity line stays).
 */
async function diffForEditedPaths(workdir: string, paths: string[]): Promise<string> {
  if (paths.length === 0) return '';
  const sorted = [...new Set(paths)].sort();
  const runGit = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd: workdir,
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return null;
    }
  };
  await runGit(['add', '--intent-to-add', '--', ...sorted]);
  const diff = (await runGit(['diff', '--no-color', '--', ...sorted])) ?? '';
  await runGit(['reset', '-q', '--', ...sorted]);
  return capInlineDiff(diff);
}

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
  if (name === 'read_file' || name === 'write_file' || name === 'edit' || name === 'list_files') {
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
  if (name === 'write_file' || name === 'edit') {
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
  if (name === 'web_extract' || name === 'web_crawl') {
    base['url'] = String(args['url'] ?? '');
    if (!ok && /^permission denied/i.test(result.trim())) {
      base['denied'] = true;
    }
  }
  if (name === 'research') {
    base['query'] = String(args['question'] ?? '');
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
  if (name === 'write_file' || name === 'edit' || name === 'read_file' || name === 'list_files') {
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
  if (name === 'web_extract' || name === 'web_crawl') {
    return typeof args['url'] === 'string' ? `url: ${args['url']}` : undefined;
  }
  if (name === 'research') {
    return typeof args['question'] === 'string' ? `question: ${args['question']}` : undefined;
  }
  return undefined;
}
