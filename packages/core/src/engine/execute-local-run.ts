import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import {
  createLspSession,
  executeNativeTool,
  languageForFile,
  PermissionEngine,
  type AgentAdapter,
  type ExtensionTool,
  type LspSession,
  type ToolExecutionContext,
} from '@excalibur/agent-runtime';
import type { ChatMessage, ChatOutput, ModelGateway } from '@excalibur/model-gateway';
import { compactMessages } from '../compaction/in-turn-compactor';
import { createModelSummarizer } from '../compaction/model-summarizer';
import { DEFAULT_COMPACTION_CONFIG } from '../compaction/types';
import {
  createEvent,
  DEFAULT_LSP_CONFIG,
  generateId,
  type AgentRole,
  type ExcaliburConfig,
  type ExcaliburEvent,
  type ExcaliburEventType,
  type LocalRun,
  type RunRecord,
  type RunStatus,
} from '@excalibur/shared';
import {
  getDefaultMethodology,
  type WorkflowDefinition,
  type WorkflowPhase,
} from '@excalibur/workflow-schema';
import { EffectiveInstructionBuilder } from '../instructions/effective-instructions';
import { applyPatch, checkPatchApplies } from '../git/git';
import { planVerificationMesh } from '../verification/verification-mesh';
import { runVerificationMesh } from '../verification/verification-runner';
import type { MeshResult } from '../verification/verification-mesh';
import {
  buildClaimLedger,
  ledgerBlocks,
  type SourceProvenanceEvidence,
  summarizeLedger,
  type ClaimEvidence,
} from '../claims/claim-ledger';
import type { RunManager } from '../runs/run-manager';

/**
 * Local workflow engine (Build Contract §4.6): executes a workflow's phases
 * sequentially against the run directory. Everything is REAL: agent_work runs
 * the native tool loop (real file edits via the gateway's configured model),
 * command_group EXECUTES the configured commands through the permission-gated
 * `run_command` tool (real exit codes, no simulation), and apply_patch performs
 * a real `git apply`. The ONLY test double is the LLM itself (MockProvider) when
 * a real provider is not configured — never the execution. (Pre-de-mock, M1
 * simulated commands/apply with `simulated: true`; that is gone.)
 */

export interface ExecuteLocalRunInput {
  repoRoot: string;
  runManager: RunManager;
  run: LocalRun;
  definition: WorkflowDefinition;
  gateway: ModelGateway;
  adapter: AgentAdapter;
  config: ExcaliburConfig;
  confirm?: (question: string) => Promise<boolean>;
  /**
   * Optional free-text human channel for the model-callable `question` tool
   * (P1.8b), forwarded to the agent adapter. Present only for interactive runs;
   * absent → the tool tells the model to proceed autonomously. Additive.
   */
  ask?: (question: string) => Promise<string>;
  onEvent?: (e: ExcaliburEvent) => void;
  /**
   * Optional LIVE narration sink, forwarded to the agent adapter so a streaming
   * provider types the model's prose out token by token (the warm pair-programmer
   * voice, alive). Live-only — not persisted; omit it and the run is non-streamed.
   * Additive. The CLI wires this to the Ink rail on a TTY.
   */
  onNarration?: (chunk: { delta: string; content: string }) => void;
  /**
   * Optional abort signal. Aborting ends the run at the next phase boundary
   * (`status: 'cancelled'`) and is forwarded to the agent adapter so an in-flight
   * `agent_work` tool loop / model call is cancelled too. Lets a server or the
   * shell stop a run mid-flight. Additive — existing callers omit it.
   */
  signal?: AbortSignal;
  /**
   * Tools contributed by loaded extensions, forwarded to the agent adapter's
   * `agent_work` runs (extensions-spec.md §5). The CLI activates extensions
   * (`activateExtensions`) and passes the harvested tools here; omit it and runs
   * use the native tool set only. Additive.
   */
  extensionTools?: ExtensionTool[];
  /**
   * Hard per-run budget ceiling in CENTS (overrides `config.budget.maxRunUsd`).
   * When the run's accumulated model spend reaches it, the next model call is
   * DENIED and the run ends `failed`. Undefined → fall back to config → no cap.
   */
  budgetCents?: number;
  /**
   * Self-contained custom agent overrides (P1.7). When the user selects a custom
   * agent (`--agent <name>` → a `.excalibur/agents/<name>.md` file), the CLI
   * resolves it and passes its persona, model, sampling and guardrails here; the
   * engine applies them to every `agent_work` phase. Additive — ordinary runs
   * omit it and use the workflow's role + the run's configured provider.
   */
  agent?: {
    systemPrompt?: string;
    role?: AgentRole;
    model?: string;
    provider?: string;
    temperature?: number;
    allowedTools?: string[];
    permissions?: ExcaliburConfig['permissions'];
  };
}

/** Thrown when a run hits its hard budget cap — Excalibur STOPS, it doesn't just track. */
export class BudgetExceededError extends Error {
  readonly code = 'budget_exceeded';
  constructor(
    readonly spentCents: number,
    readonly capCents: number,
  ) {
    super(
      `Budget cap reached: $${(spentCents / 100).toFixed(2)} spent of a $${(capCents / 100).toFixed(2)} ceiling. ` +
        `Run stopped before the next model call — raise budget.maxRunUsd or pass --budget to continue.`,
    );
    this.name = 'BudgetExceededError';
  }
}

/** Maps a phase onto the MockProvider response kind (Build Contract §7). */
function responseKindFor(phase: WorkflowPhase): string {
  if (phase.type === 'agent_review') {
    return 'review';
  }
  if (phase.type === 'patch_generation') {
    return 'patch';
  }
  const output = phase.output ?? '';
  if (output.includes('alternatives')) return 'alternatives';
  if (output.includes('plan')) return 'plan';
  if (output.includes('summary')) return 'summary';
  if (output.includes('review')) return 'review';
  switch (phase.role) {
    case 'planner':
      return 'plan';
    case 'architect':
      return 'alternatives';
    case 'reviewer':
    case 'security':
      return 'review';
    case 'release':
      return 'summary';
    case 'tester':
      return 'test_generation';
    default:
      return 'ask';
  }
}

/** Heuristic: does a changed path live in a sensitive area (→ widen the mesh)? */
const SENSITIVE_PATH_RE = /(^|\/)(auth|billing|payments?|secrets?|credentials?)(\/|\.)|\.env/i;
function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_RE.test(path);
}

/** Renders a Verification Mesh result as the `verification.md` artifact. */
function meshMarkdown(runId: string, result: MeshResult): string {
  return [
    `# Verification mesh — ${runId}`,
    '',
    `${result.blocked ? '**BLOCKED**' : 'Passed'} · lenses: ${result.lensesRun.join(', ')}`,
    '',
    ...(result.issues.length === 0
      ? ['No issues found.']
      : result.issues.map(
          (i) =>
            `- [${i.severity}] ${i.file !== undefined ? `${i.file} — ` : ''}${i.problem}${i.fix !== undefined ? `\n  - fix: ${i.fix}` : ''}`,
        )),
    '',
  ].join('\n');
}

/** Renders the claim ledger as the `claims.md` artifact. */
function claimsMarkdown(
  runId: string,
  verdicts: ReadonlyArray<{
    kind: string;
    statement: string;
    status: string;
    asserted: boolean;
    evidence?: string;
  }>,
  summary: string,
): string {
  const glyph = (status: string): string =>
    status === 'verified' ? '✓' : status === 'refuted' ? '✗' : '?';
  return [
    `# Claim ledger — ${runId}`,
    '',
    summary,
    '',
    ...verdicts.map(
      (v) =>
        `- ${glyph(v.status)} [${v.status}] ${v.statement}${v.asserted ? ' (model asserted)' : ''}` +
        `${v.evidence !== undefined ? `\n  - evidence: ${v.evidence}` : ''}`,
    ),
    '',
  ].join('\n');
}

/** Pulls the unified diff out of a ```diff fenced block. */
function extractUnifiedDiff(content: string): string | null {
  const match = /```diff\r?\n([\s\S]*?)\r?\n?```/.exec(content);
  const diff = match?.[1]?.trim();
  return diff !== undefined && diff.length > 0 ? diff : null;
}

/** Reads the affected file paths from `+++ b/<path>` lines of a unified diff. */
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

/** Deterministic fallback diff for non-mock providers without a ```diff block. */
function fallbackDiff(title: string): string {
  const target =
    /[\w./-]+\.(?:ts|js|tsx|py|go|rb|java)\b/.exec(title)?.[0] ?? 'src/example.service.ts';
  return [
    `--- a/${target}`,
    `+++ b/${target}`,
    '@@ -10,6 +10,10 @@',
    '   async handle(id: string): Promise<void> {',
    '     const record = await this.repository.findById(id);',
    '',
    '+    if (record.processedAt !== null) {',
    '+      // Idempotency guard: repeated handling must be a no-op.',
    '+      return;',
    '+    }',
    '     record.processedAt = new Date();',
    '     await this.repository.save(record);',
    '   }',
  ].join('\n');
}

class LocalRunExecution {
  private readonly input: ExecuteLocalRunInput;
  private readonly run: LocalRun;
  private instructionsMarkdown = '';
  private collectedDiff: string | null = null;
  /** Accumulated model spend (cents) — checked against the budget cap. */
  private spentCents = 0;
  /** Hard budget ceiling in cents, or null for no cap. */
  private readonly budgetCapCents: number | null;
  // --- Claim-ledger evidence, accumulated from the event stream ---------------
  /** Combined assistant text (the model's claims are parsed from this). */
  private claimText = '';
  /** Provenance of untrusted web/MCP sources (F8) → the `source_trust` claim. */
  private readonly provenanceRecords: SourceProvenanceEvidence[] = [];
  /** Last exit code per command that ACTUALLY ran (verifies test/typecheck/build claims). */
  private readonly commandExits = new Map<string, number>();
  /** Run-scoped LSP session for post-apply diagnostics (lazy; closed in execute's finally). */
  private lsp: LspSession | null = null;
  /** Whether the LSP session actually produced diagnostics this run (gates claim evidence). */
  private lspRan = false;
  /** Total LSP errors across all applied files (feeds `no_type_errors` when no typecheck cmd). */
  private lspErrorTotal = 0;

  constructor(input: ExecuteLocalRunInput) {
    this.input = input;
    this.run = input.run;
    const fromUsd = input.config.budget?.maxRunUsd;
    this.budgetCapCents =
      input.budgetCents ??
      (typeof fromUsd === 'number' && fromUsd > 0 ? Math.round(fromUsd * 100) : null);
  }

  // --- event plumbing --------------------------------------------------------

  private forward(event: ExcaliburEvent): void {
    this.input.runManager.appendEvent(this.run.id, event);
    this.input.onEvent?.(event);
    this.captureClaimEvidence(event);
  }

  /** Folds an event into the claim-ledger evidence (assistant text + tool outcomes). */
  private captureClaimEvidence(event: ExcaliburEvent): void {
    const p = event.payload;
    if (event.type === 'assistant_message') {
      const content = p['content'];
      if (typeof content === 'string' && content.length > 0) {
        this.claimText += `${content}\n`;
      }
    } else if (event.type === 'command_completed') {
      // A denied/skipped command is NOT evidence of failure — it never ran.
      if (p['denied'] === true || p['skipped'] === true) {
        return;
      }
      const command = p['command'];
      const exitCode = p['exitCode'];
      if (typeof command === 'string' && typeof exitCode === 'number') {
        this.commandExits.set(command, exitCode);
      }
    } else if (event.type === 'provenance') {
      // F8: record each untrusted web/MCP source for the `source_trust` claim.
      const verdict = p['verdict'];
      if (verdict === 'clean' || verdict === 'suspicious' || verdict === 'malicious') {
        this.provenanceRecords.push({
          source: typeof p['source'] === 'string' ? p['source'] : 'web',
          ...(typeof p['url'] === 'string' ? { url: p['url'] } : {}),
          verdict,
          blocked: p['blocked'] === true,
        });
      }
    }
  }

  private emit(type: ExcaliburEventType, payload: Record<string, unknown>, phaseId?: string): void {
    this.forward(createEvent({ runId: this.run.id, type, payload, phaseId: phaseId ?? null }));
  }

  // --- gateway plumbing ------------------------------------------------------

  /**
   * Builds the IN-TURN context compactor handed to the native loop (covers every
   * run mode — interactive + non-interactive). Off when `compaction.enabled` is
   * false. Routes the Tier-2 summary to the `cheap` role (fast); Tier-1 pruning
   * needs no model. Returns undefined → the loop runs without in-turn compaction.
   */
  private inTurnCompactor():
    | ((messages: ChatMessage[]) => Promise<ChatMessage[] | null>)
    | undefined {
    const compaction = this.input.config.compaction ?? DEFAULT_COMPACTION_CONFIG;
    if (!compaction.enabled) {
      return undefined;
    }
    // Defensive: a non-standard gateway wrapper (custom host, test double) may not
    // implement the read-only window/provider getters. If anything is missing or
    // throws, return undefined — in-turn compaction is purely additive and must
    // never break a run by its mere construction.
    try {
      const gateway = this.input.gateway;
      if (
        typeof gateway.contextWindow !== 'function' ||
        typeof gateway.providerType !== 'function' ||
        typeof gateway.cheapProviderName !== 'function'
      ) {
        return undefined;
      }
      const contextWindow = gateway.contextWindow() ?? 128_000;

      // Resolve the Tier-2 summarizer provider exactly as session compaction does:
      // `cheap` → the fast pairing model (gateway falls back to the main model when
      // none is set); `active` → the main model; a concrete id → that provider. A
      // `mock` provider is a test double — skip Tier 2 so it never emits a nonsense
      // summary; Tier 1 pruning needs no model and still keeps the turn in-window.
      const summarizerProvider =
        compaction.summarizerModel === 'cheap'
          ? gateway.cheapProviderName()
          : compaction.summarizerModel === 'active'
            ? undefined
            : compaction.summarizerModel;
      const summarize =
        gateway.providerType(summarizerProvider) === 'mock'
          ? undefined
          : createModelSummarizer({
              chat: gateway,
              ...(summarizerProvider !== undefined ? { provider: summarizerProvider } : {}),
              pruneToolOutputs: compaction.pruneToolOutputs,
            });

      return (messages: ChatMessage[]): Promise<ChatMessage[] | null> =>
        compactMessages(messages, {
          contextWindow,
          reserveTokens: compaction.reserveTokens,
          keepRecentTokens: compaction.keepRecentTokens,
          ...(summarize !== undefined ? { summarize } : {}),
        });
    } catch {
      return undefined;
    }
  }

  private async chat(
    kind: string,
    userContent: string,
    phase?: WorkflowPhase,
  ): Promise<ChatOutput> {
    const roleLine =
      phase !== undefined
        ? `You are the Excalibur "${phase.role ?? 'planner'}" agent for phase "${phase.name}" of workflow "${this.input.definition.id}".`
        : `You are the Excalibur assistant for workflow "${this.input.definition.id}".`;
    const system =
      this.instructionsMarkdown.length > 0
        ? `${this.instructionsMarkdown}\n\n${roleLine}`
        : roleLine;
    // HARD BUDGET CAP (deny-by-dollars): refuse the next model call once spend
    // has reached the ceiling. We check BEFORE the call (the cap is a ceiling,
    // not a target) — at worst we overshoot by the single call that crossed it.
    if (this.budgetCapCents !== null && this.spentCents >= this.budgetCapCents) {
      this.emit(
        'policy_decision',
        {
          kind: 'budget',
          decision: 'deny',
          message: `Budget cap $${(this.budgetCapCents / 100).toFixed(2)} reached ($${(this.spentCents / 100).toFixed(2)} spent) — denying further model calls.`,
          spentCents: this.spentCents,
          capCents: this.budgetCapCents,
        },
        phase?.id,
      );
      throw new BudgetExceededError(this.spentCents, this.budgetCapCents);
    }
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
    ];
    const output = await this.input.gateway.chat({
      // `record.model` holds the PROVIDER name (e.g. `groq`), not a model id, so
      // it selects the provider and the gateway resolves the real model from
      // that provider's `providers.yaml` config. Passing it as `model` would
      // override the model id with the provider name (→ 404 model_not_found).
      ...(this.run.record.model !== null ? { provider: this.run.record.model } : {}),
      messages,
      metadata: { kind, runId: this.run.id, phaseId: phase?.id ?? null },
    });

    this.spentCents += output.costCents ?? 0;
    this.input.runManager.appendModelCall(this.run.id, {
      provider: this.input.config.models?.default ?? 'mock',
      model: output.model,
      inputTokens: output.usage.inputTokens,
      outputTokens: output.usage.outputTokens,
      costCents: output.costCents,
      timestamp: new Date().toISOString(),
    });
    this.emit(
      'model_call',
      {
        model: output.model,
        kind,
        inputTokens: output.usage.inputTokens,
        outputTokens: output.usage.outputTokens,
        costCents: output.costCents,
        finishReason: output.finishReason,
      },
      phase?.id,
    );
    return output;
  }

  private async confirm(question: string, phaseId: string): Promise<boolean> {
    this.emit('approval_requested', { question, auto: this.input.confirm === undefined }, phaseId);
    if (this.input.confirm === undefined) {
      // No confirm callback: auto-approve (non-interactive M1 default).
      this.emit('approval_approved', { auto: true }, phaseId);
      return true;
    }
    const approved = await this.input.confirm(question);
    this.emit(approved ? 'approval_approved' : 'approval_rejected', { auto: false }, phaseId);
    return approved;
  }

  // --- phase behaviors -------------------------------------------------------

  private async assistantPhase(phase: WorkflowPhase): Promise<void> {
    const kind = responseKindFor(phase);
    const output = await this.chat(
      kind,
      `Task: ${this.run.record.title}\nPhase: ${phase.name} (${phase.type}).`,
      phase,
    );
    const fileName = phase.output ?? `${phase.id}.md`;
    this.input.runManager.writeArtifact(this.run.id, fileName, `${output.content}\n`);
    this.emit('assistant_message', { content: output.content, artifact: fileName }, phase.id);
  }

  private async patchGenerationPhase(phase: WorkflowPhase): Promise<void> {
    const output = await this.chat(
      'patch',
      `Task: ${this.run.record.title}\nGenerate a unified diff patch for this task.`,
      phase,
    );
    const diff = extractUnifiedDiff(output.content) ?? fallbackDiff(this.run.record.title);
    this.collectedDiff = diff;
    const fileName = phase.output ?? 'diff.patch';
    this.input.runManager.writeArtifact(this.run.id, fileName, `${diff}\n`);
    this.emit(
      'patch_generated',
      { diff, filesAffected: filesAffectedFromDiff(diff), artifact: fileName },
      phase.id,
    );
  }

  private async agentWorkPhase(phase: WorkflowPhase): Promise<void> {
    // A custom agent (P1.7) overrides the role; otherwise the phase's role wins.
    const agent = this.input.agent;
    const role: AgentRole = agent?.role ?? phase.role ?? 'implementer';
    // Provider precedence: the custom agent's provider > the run's configured
    // provider (`record.model` is the PROVIDER name — forward it as `provider`
    // so the gateway resolves its real model id; passing it as `model` would
    // clobber the model id → 404 model_not_found).
    const provider =
      agent?.provider ?? (this.run.record.model !== null ? this.run.record.model : undefined);
    const prompt =
      this.instructionsMarkdown.length > 0
        ? `${this.instructionsMarkdown}\n\nTask: ${this.run.record.title}`
        : `Task: ${this.run.record.title}`;

    const compactContext = this.inTurnCompactor();
    const stream = this.input.adapter.run({
      runId: this.run.id,
      sessionId: generateId('sess'),
      workdir: this.input.repoRoot,
      prompt,
      role,
      ...(compactContext !== undefined ? { compactContext } : {}),
      ...(this.input.onNarration !== undefined ? { onNarration: this.input.onNarration } : {}),
      ...(provider !== undefined ? { provider } : {}),
      // Custom agent (P1.7): a model id, sampling, persona, tool allowlist and
      // permission overrides, each applied only when the agent specifies it.
      ...(agent?.model !== undefined ? { model: agent.model } : {}),
      ...(agent?.temperature !== undefined ? { temperature: agent.temperature } : {}),
      ...(agent?.systemPrompt !== undefined ? { systemPrompt: agent.systemPrompt } : {}),
      ...(agent?.allowedTools !== undefined ? { allowedTools: agent.allowedTools } : {}),
      ...(agent?.permissions !== undefined ? { permissions: agent.permissions } : {}),
      phase: { id: phase.id, name: phase.name, type: phase.type },
      config: this.input.config,
      gateway: this.input.gateway,
      // Forward the abort signal so cancelling a run kills the in-flight tool
      // loop / model call, not just the gap between phases.
      ...(this.input.signal !== undefined ? { signal: this.input.signal } : {}),
      // Extension-contributed tools (extensions-spec.md §5), advertised + executed
      // by the native loop alongside the native tools. Omitted → native set only.
      ...(this.input.extensionTools !== undefined && this.input.extensionTools.length > 0
        ? { extensionTools: this.input.extensionTools }
        : {}),
      // Forward a tool-level confirmer mirroring the PHASE policy: with an
      // interactive `confirm` the agent prompts per mutating tool; without one
      // (--yes / non-interactive) it AUTO-APPROVES — matching the auto-approve
      // used for phase gates. Previously no confirmer was passed, so the
      // adapter's safe default DECLINED every write/command and `run` could
      // never actually mutate the tree. Blocked paths stay hard-denied at the
      // tool-execution layer regardless.
      confirm:
        this.input.confirm !== undefined
          ? (req): Promise<boolean> =>
              this.input.confirm!(
                req.detail !== undefined ? `${req.reason} (${req.detail})` : req.reason,
              )
          : (): Promise<boolean> => Promise.resolve(true),
      // Free-text human channel for the `question` tool (P1.8b). Forwarded only
      // when an interactive caller supplied it; otherwise the tool proceeds.
      ...(this.input.ask !== undefined ? { ask: this.input.ask } : {}),
    });

    for await (const event of stream) {
      this.forward(event);
      if (event.type === 'patch_generated') {
        const diff = event.payload['diff'];
        if (typeof diff === 'string' && diff.length > 0) {
          this.collectedDiff = diff;
          this.input.runManager.writeArtifact(this.run.id, 'diff.patch', `${diff}\n`);
        }
      }
      if (event.type === 'model_call') {
        const inputTokens = event.payload['inputTokens'];
        const outputTokens = event.payload['outputTokens'];
        const model = event.payload['model'];
        const cost =
          typeof event.payload['costCents'] === 'number'
            ? (event.payload['costCents'] as number)
            : null;
        if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
          this.input.runManager.appendModelCall(this.run.id, {
            provider: this.input.config.models?.default ?? 'mock',
            model: typeof model === 'string' ? model : 'mock-model',
            inputTokens,
            outputTokens,
            costCents: cost,
            timestamp: new Date().toISOString(),
          });
        }
        // HARD BUDGET CAP also covers the AGENT loop (the dominant cost): accrue
        // each iteration's spend and ABORT the loop the moment the ceiling is hit
        // — otherwise an agent_work-heavy run could blow past the cap unseen.
        this.spentCents += cost ?? 0;
        if (this.budgetCapCents !== null && this.spentCents >= this.budgetCapCents) {
          this.emit(
            'policy_decision',
            {
              kind: 'budget',
              decision: 'deny',
              message: `Budget cap $${(this.budgetCapCents / 100).toFixed(2)} reached ($${(this.spentCents / 100).toFixed(2)} spent) — stopping the agent loop.`,
              spentCents: this.spentCents,
              capCents: this.budgetCapCents,
            },
            phase.id,
          );
          throw new BudgetExceededError(this.spentCents, this.budgetCapCents);
        }
      }
    }
  }

  /**
   * Runs the phase's commands FOR REAL, fully gated: each command is checked by
   * the PermissionEngine — a blocked command is DENIED (never run), a
   * non-allowlisted one (incl. the default `run_command: ask` policy) PROMPTS
   * via the phase confirmer (auto-approved only non-interactively, mirroring
   * agentWorkPhase), and only then is it executed through `run_command`
   * (sandbox-aware, redacted). NO simulation. A failing command marks the
   * verify phase 'failed' in the artifact + event, but is NON-FATAL by design
   * (verify is informational — it does not crash the run; the agent's edits may
   * already stand). The real exit code is surfaced per command.
   */
  private async commandGroupPhase(phase: WorkflowPhase): Promise<void> {
    const commands: string[] = [...(phase.commands ?? [])];
    if (phase.commandsFromConfig === true) {
      const detected = this.input.config.commands ?? {};
      for (const key of ['test', 'lint', 'typecheck', 'build'] as const) {
        const command = detected[key];
        if (typeof command === 'string' && command.length > 0 && !commands.includes(command)) {
          commands.push(command);
        }
      }
    }
    if (commands.length === 0) {
      commands.push(...(this.input.definition.defaults?.commands ?? []));
    }

    const permissions = new PermissionEngine(this.input.config.permissions);
    const ctx: ToolExecutionContext = {
      workdir: this.input.repoRoot,
      config: this.input.config,
      permissions,
    };

    const logLines: string[] = [];
    let allPassed = true;
    let ran = 0;
    for (const command of commands) {
      this.emit('command_started', { command }, phase.id);
      // Gate exactly like the agent's run_command path: deny → never run;
      // ask → confirm (auto-approved only when non-interactive).
      const decision = permissions.checkCommand(command);
      if (!decision.allowed) {
        // A DENIED command never ran → it is NOT evidence of failure (same
        // invariant the claim ledger honours). Do not flip the aggregate.
        this.emit('command_completed', { command, exitCode: -1, denied: true }, phase.id);
        logLines.push(`$ ${command}\n[denied] ${decision.reason}`);
        continue;
      }
      if (decision.requiresConfirmation && !(await this.confirm(`Run "${command}"?`, phase.id))) {
        this.emit('command_completed', { command, exitCode: -1, skipped: true }, phase.id);
        logLines.push(`$ ${command}\n[skipped — not approved]`);
        continue;
      }
      const { ok, result } = await executeNativeTool('run_command', { command }, ctx);
      ran += 1;
      if (!ok) {
        allPassed = false;
      }
      // Surface the REAL exit code (parsed from the command result), not a flat 1.
      const codeMatch = /exit code:\s*(-?\d+)/.exec(result);
      const exitCode = codeMatch !== null ? Number.parseInt(codeMatch[1] ?? '0', 10) : ok ? 0 : 1;
      this.emit('command_completed', { command, exitCode }, phase.id);
      logLines.push(`$ ${command}\n${result}`);
    }

    // No commands actually ran → nothing to verify (honest: not a fake "passed").
    const status: 'passed' | 'failed' | 'skipped' =
      ran === 0 && allPassed ? 'skipped' : allPassed ? 'passed' : 'failed';
    this.emit('test_result', { status, commands }, phase.id);

    this.input.runManager.writeArtifact(
      this.run.id,
      'test-results.json',
      `${JSON.stringify({ status, commands, timestamp: new Date().toISOString() }, null, 2)}\n`,
    );
    this.input.runManager.writeArtifact(
      this.run.id,
      'tests.log',
      `${logLines.length > 0 ? logLines.join('\n\n') : 'no commands configured'}\n`,
    );
  }

  /** Denied required approvals cancel the run; denied optional ones skip. */
  private async humanApprovalPhase(
    phase: WorkflowPhase,
  ): Promise<'completed' | 'skipped' | 'cancelled'> {
    const approved = await this.confirm(
      `Approve phase "${phase.name}" of run ${this.run.id}?`,
      phase.id,
    );
    if (approved) {
      return 'completed';
    }
    return phase.required === false ? 'skipped' : 'cancelled';
  }

  /**
   * Applies the collected diff to the working tree FOR REAL (gated by `confirm`,
   * pre-flight-checked with `git apply --check`). No simulation: if there is no
   * diff, nothing is applied; if the diff does not apply cleanly, the phase fails
   * loudly rather than emitting a fake success. (When the agent_work phase wrote
   * files directly, the tree is already mutated and there is no separate diff to
   * apply — that path is a no-op here, correctly.)
   */
  private async applyPatchPhase(phase: WorkflowPhase): Promise<void> {
    if (this.collectedDiff === null || this.collectedDiff.trim().length === 0) {
      return; // nothing was generated to apply (e.g. agent_work mutated the tree directly)
    }
    const approved = await this.confirm(
      `Apply the generated patch for run ${this.run.id}?`,
      phase.id,
    );
    if (!approved) {
      return;
    }
    const filesAffected = filesAffectedFromDiff(this.collectedDiff);
    const check = checkPatchApplies(this.input.repoRoot, this.collectedDiff);
    if (!check.applies) {
      // Honest + non-fatal: the patch did NOT apply, so we emit a real error
      // event (never a fake `patch_applied`) and leave the diff.patch artifact
      // for the user — but we do NOT crash the run (the agent may already have
      // mutated the tree directly, and a bad generated diff shouldn't nuke it).
      this.emit(
        'error',
        {
          message: `patch did not apply: ${check.reason ?? 'unknown'}`,
          filesAffected,
          fatal: false,
        },
        phase.id,
      );
      return;
    }
    applyPatch(this.input.repoRoot, this.collectedDiff);
    this.emit('patch_applied', { filesAffected }, phase.id);
    // LSP grounding (P1.10 fast-follow): a patch_generation→apply flow never
    // enters the native tool loop where per-edit diagnostics fire, so query the
    // language server for the just-applied files here — emit a `diagnostics`
    // event each AND accumulate the error total for the claim gate.
    await this.runLspDiagnostics(filesAffected, phase.id);
  }

  /**
   * Runs the language server over freshly-applied files, emits a `diagnostics`
   * event per supported file, and accumulates the error total. Lazy + totally
   * graceful (no server / failure → no-op); gives fast-fix/patch workflows the
   * same compiler grounding the agent_work loop already has.
   */
  private async runLspDiagnostics(files: ReadonlyArray<string>, phaseId: string): Promise<void> {
    if (this.input.config.lsp?.enabled === false) {
      return;
    }
    const targets = [...new Set(files)].filter((file) => languageForFile(file) !== null);
    if (targets.length === 0) {
      return;
    }
    if (this.lsp === null) {
      this.lsp = createLspSession({
        workdir: this.input.repoRoot,
        config: this.input.config.lsp ?? DEFAULT_LSP_CONFIG,
      });
    }
    for (const file of targets) {
      const language = languageForFile(file);
      if (language !== null) this.lsp.ensureStarted(language);
    }
    for (const file of targets) {
      const diag = await this.lsp.diagnosticsFor(file);
      if (diag === null) continue;
      this.lspRan = true;
      this.lspErrorTotal += diag.errorCount;
      this.emit('diagnostics', diag as unknown as Record<string, unknown>, phaseId);
    }
  }

  private async pullRequestPhase(phase: WorkflowPhase): Promise<void> {
    const output = await this.chat(
      'summary',
      `Task: ${this.run.record.title}\nWrite a pull request summary for the completed work.`,
      phase,
    );
    const fileName = phase.output ?? 'pr-summary.md';
    const path = this.input.runManager.writeArtifact(this.run.id, fileName, `${output.content}\n`);
    this.emit('artifact_created', { artifact: fileName, path }, phase.id);
  }

  private discoveryQuestionsPhase(phase: WorkflowPhase): void {
    // Interactive question packs run through `excalibur discovery` (D-7);
    // inside the generic engine the phase only records a pointer artifact.
    const fileName = phase.output ?? 'transcript.md';
    this.input.runManager.writeArtifact(
      this.run.id,
      fileName,
      '# Discovery questions\n\nGuided questions run interactively via `excalibur discovery`.\n',
    );
  }

  /** Returns 'completed' | 'skipped'; throws on phase failure (abort). */
  private async executePhase(phase: WorkflowPhase): Promise<'completed' | 'skipped' | 'cancelled'> {
    switch (phase.type) {
      case 'assistant_interaction':
      case 'agent_output':
      case 'agent_review':
        await this.assistantPhase(phase);
        return 'completed';
      case 'patch_generation':
        await this.patchGenerationPhase(phase);
        return 'completed';
      case 'agent_work':
        await this.agentWorkPhase(phase);
        return 'completed';
      case 'command_group':
        await this.commandGroupPhase(phase);
        return 'completed';
      case 'human_approval':
        return this.humanApprovalPhase(phase);
      case 'apply_patch':
        await this.applyPatchPhase(phase);
        return 'completed';
      case 'pull_request':
        await this.pullRequestPhase(phase);
        return 'completed';
      case 'discovery_questions':
        this.discoveryQuestionsPhase(phase);
        return 'completed';
      case 'custom':
      default:
        return 'skipped';
    }
  }

  // --- run lifecycle ----------------------------------------------------------

  private writeStaticArtifacts(): void {
    const { runManager, definition } = this.input;
    runManager.writeArtifact(this.run.id, 'workflow.yaml', stringifyYaml(definition));
    const methodologyId = this.run.record.methodology;
    if (methodologyId !== null) {
      const methodology = getDefaultMethodology(methodologyId);
      if (methodology !== undefined) {
        runManager.writeArtifact(this.run.id, 'methodology.yaml', stringifyYaml(methodology));
      }
    }
    if (!existsSync(join(this.run.dir, 'input.md'))) {
      runManager.writeArtifact(this.run.id, 'input.md', `${this.run.record.title}\n`);
    }
  }

  /**
   * Adversarial Verification Mesh gate (PROPORTIONAL + GOVERNABLE). When the
   * workflow includes a review phase (or `verification.mesh: always`) and the
   * change has a diff, runs the mesh — lens set scaled to risk — over the
   * collected diff, persists the verdict (verification.md), and returns true to
   * BLOCK completion if a high-severity issue survived. Always best-effort: a
   * mesh/model error never blocks (we could not verify → do not punish the run).
   * `verification.mesh: off` disables it.
   */
  private async verificationGate(): Promise<boolean> {
    const mode = this.input.config.verification?.mesh ?? 'auto';
    if (mode === 'off') {
      return false;
    }
    const diff = this.collectedDiff;
    if (diff === null || diff.trim().length === 0) {
      return false;
    }
    const hasReview = this.input.definition.phases.some((p) => p.type === 'agent_review');
    if (!hasReview && mode !== 'always') {
      return false; // proportional: only review-bearing workflows get the mesh
    }
    try {
      const files = filesAffectedFromDiff(diff);
      const plan = planVerificationMesh({
        taskType: 'feature',
        sensitive: files.some(isSensitivePath),
        affectedUnits: files.length,
        autonomyLevel: this.run.record.autonomyLevel,
        hasTests: typeof this.input.config.commands?.test === 'string',
        mode,
      });
      if (plan.lenses.length === 0) {
        return false;
      }
      this.emit('policy_decision', {
        kind: 'log',
        decision: 'allow',
        message: `Verification mesh — ${plan.reason}`,
      });
      const result = await runVerificationMesh({
        diff,
        lenses: plan.lenses,
        gateway: this.input.gateway,
        ...(this.run.record.model !== null ? { provider: this.run.record.model } : {}),
      });
      this.input.runManager.writeArtifact(
        this.run.id,
        'verification.md',
        meshMarkdown(this.run.id, result),
      );
      // First-class `verification` event (#26): replayable/forkable/auditable
      // verdict; Enterprise maps it to its own audit type. blocked === gated.
      this.emit('verification', {
        blocked: result.blocked,
        lenses: result.lensesRun,
        issues: result.issues,
        summary: result.summary,
      });
      return result.blocked;
    } catch {
      // Mesh/model failure → we could not verify; never block on that.
      return false;
    }
  }

  /**
   * The CLAIM LEDGER gate (plan P2.4): cross-references the model's stated claims
   * (parsed from its messages) and the run's implied claims against REAL tool
   * evidence (test/typecheck/build exit codes, a secret scan of the diff), emits
   * one typed `claim` event per verdict, and returns true to BLOCK completion if
   * a blocking claim is REFUTED (the model said tests pass when they failed, or a
   * secret slipped into the diff). Deterministic + evidence-linked; never throws.
   */
  private claimGate(): boolean {
    try {
      const commandFor = (cmd: string | undefined): boolean | null => {
        if (cmd === undefined) return null;
        const exit = this.commandExits.get(cmd);
        return exit === undefined ? null : exit === 0;
      };
      // `no_type_errors` evidence: the configured `typecheck` command's exit code
      // is authoritative (whole-repo). When NO typecheck command ran but the LSP
      // server DID diagnose the applied files, use the LSP error total — so a
      // patch that introduces type errors is caught even without a `typecheck`.
      const typecheckFromCommand = commandFor(this.input.config.commands?.typecheck);
      const typecheckPassed =
        typecheckFromCommand !== null
          ? typecheckFromCommand
          : this.lspRan
            ? this.lspErrorTotal === 0
            : null;
      const evidence: ClaimEvidence = {
        // Derive each from the EXACT configured command's own exit code (denied/
        // skipped commands are excluded) — never from a conflated test+lint+build
        // aggregate, so a lint failure can't refute the `tests pass` claim.
        testsPassed: commandFor(this.input.config.commands?.test),
        typecheckPassed,
        buildPassed: commandFor(this.input.config.commands?.build),
        diff: this.collectedDiff,
        // F8: fold the run's untrusted-source provenance into a `source_trust`
        // claim (blocks only when web.injection.blockOnMalicious is set).
        ...(this.provenanceRecords.length > 0 ? { provenance: this.provenanceRecords } : {}),
        ...(this.input.config.web?.injection?.blockOnMalicious === true
          ? { blockOnMalicious: true }
          : {}),
      };
      const verdicts = buildClaimLedger(this.claimText, evidence);
      if (verdicts.length === 0) {
        return false;
      }
      for (const v of verdicts) {
        this.emit('claim', {
          kind: v.kind,
          statement: v.statement,
          status: v.status,
          asserted: v.asserted,
          ...(v.evidence !== undefined ? { evidence: v.evidence } : {}),
        });
      }
      this.input.runManager.writeArtifact(
        this.run.id,
        'claims.md',
        claimsMarkdown(this.run.id, verdicts, summarizeLedger(verdicts)),
      );
      return ledgerBlocks(verdicts);
    } catch {
      // The ledger is best-effort — a parse/IO fault never blocks the run.
      return false;
    }
  }

  private finish(status: RunStatus): RunRecord {
    const record = this.input.runManager.updateRecord(this.run.id, {
      status,
      completedAt: new Date().toISOString(),
    });
    this.emit('run_completed', { status });
    return record;
  }

  async execute(): Promise<RunRecord> {
    const { runManager, definition } = this.input;
    const record = this.run.record;

    runManager.updateRecord(this.run.id, { status: 'running' });
    this.writeStaticArtifacts();

    this.emit('run_started', {
      title: record.title,
      autonomyLevel: record.autonomyLevel,
      workflow: record.workflow,
      executionStyle: record.executionStyle,
    });
    this.emit('workflow_selected', { workflowId: definition.id, name: definition.name });
    if (record.methodology !== null) {
      this.emit('methodology_selected', { methodologyId: record.methodology });
    }

    try {
      const builder = new EffectiveInstructionBuilder({ repoRoot: this.input.repoRoot });
      const effective = await builder.build({
        repositoryPath: this.input.repoRoot,
        workflowId: definition.id,
        autonomyLevel: record.autonomyLevel,
      });
      this.instructionsMarkdown = effective.instructionsMarkdown;
      // Frozen event enum has no `log` type: the ISD log event (spec §9)
      // travels as a `policy_decision` with `payload.kind = 'log'`.
      this.emit('policy_decision', {
        kind: 'log',
        decision: 'allow',
        message: 'Effective instructions prepared for this run.',
        instructionSources: effective.sources.map((source) => source.path),
        instructionWarnings: effective.warnings,
      });

      for (const phase of definition.phases) {
        // Cancellation: an aborted signal ends the run cleanly at the phase
        // boundary (the in-flight agent_work loop is aborted via the forwarded
        // signal; this catches the gap between phases and non-agent phases).
        if (this.input.signal?.aborted === true) {
          return this.finish('cancelled');
        }
        this.emit('phase_started', { name: phase.name, type: phase.type }, phase.id);

        let outcome: 'completed' | 'skipped' | 'cancelled' = 'skipped';
        const attempts = phase.onFailure === 'retry' ? 1 + (phase.maxRetries ?? 1) : 1;
        let lastError: unknown = null;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          try {
            outcome = await this.executePhase(phase);
            lastError = null;
            break;
          } catch (error) {
            // The hard budget cap is NON-RECOVERABLE: never retry it (the next
            // call would just re-deny) and never let `onFailure` swallow it —
            // it must always end the run. "Excalibur STOPS, it doesn't track."
            if (error instanceof BudgetExceededError) {
              throw error;
            }
            lastError = error;
          }
        }

        if (lastError !== null) {
          if (phase.onFailure === 'continue') {
            const message = lastError instanceof Error ? lastError.message : String(lastError);
            this.emit('error', { message, phase: phase.id, recovered: true }, phase.id);
            this.emit('phase_completed', { name: phase.name, status: 'failed' }, phase.id);
            continue;
          }
          throw lastError;
        }

        if (outcome === 'cancelled') {
          this.emit('phase_completed', { name: phase.name, status: 'skipped' }, phase.id);
          return this.finish('cancelled');
        }
        this.emit('phase_completed', { name: phase.name, status: outcome }, phase.id);
      }

      // Quality gates (both run + emit their evidence; either can block):
      //  - Claim ledger: the model's claims vs. real tool evidence (a lie / a
      //    leaked secret blocks).
      //  - Verification mesh: adversarial review of the diff (a HIGH blocks).
      const claimBlocked = this.claimGate();
      const meshBlocked = await this.verificationGate();
      if (claimBlocked || meshBlocked) {
        return this.finish('failed');
      }
      return this.finish('completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        typeof (error as { code?: unknown }).code === 'string'
          ? ((error as { code: string }).code as string)
          : 'run_failed';
      this.emit('error', { message, code });
      return this.finish('failed');
    } finally {
      // Reclaim the language-server subprocess on every exit path.
      this.lsp?.close();
    }
  }
}

/**
 * Executes a local run: sequential phases with `phase_started`/`phase_completed`
 * bookends, lifecycle events (`run_started`, `workflow_selected`, optional
 * `methodology_selected` … `run_completed`), per-phase-type M1 behavior and
 * error → `failed` handling. Returns the final `RunRecord` (status reflected
 * in `run.json`).
 */
export async function executeLocalRun(input: ExecuteLocalRunInput): Promise<RunRecord> {
  return new LocalRunExecution(input).execute();
}
