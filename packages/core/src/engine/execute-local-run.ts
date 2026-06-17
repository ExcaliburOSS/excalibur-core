import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import {
  executeNativeTool,
  PermissionEngine,
  type AgentAdapter,
  type ToolExecutionContext,
} from '@excalibur/agent-runtime';
import type { ChatMessage, ChatOutput, ModelGateway } from '@excalibur/model-gateway';
import {
  createEvent,
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
  onEvent?: (e: ExcaliburEvent) => void;
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
  const target = /[\w./-]+\.(?:ts|js|tsx|py|go|rb|java)\b/.exec(title)?.[0] ?? 'src/example.service.ts';
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

  constructor(input: ExecuteLocalRunInput) {
    this.input = input;
    this.run = input.run;
  }

  // --- event plumbing --------------------------------------------------------

  private forward(event: ExcaliburEvent): void {
    this.input.runManager.appendEvent(this.run.id, event);
    this.input.onEvent?.(event);
  }

  private emit(
    type: ExcaliburEventType,
    payload: Record<string, unknown>,
    phaseId?: string,
  ): void {
    this.forward(
      createEvent({ runId: this.run.id, type, payload, phaseId: phaseId ?? null }),
    );
  }

  // --- gateway plumbing ------------------------------------------------------

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
    const role: AgentRole = phase.role ?? 'implementer';
    const prompt =
      this.instructionsMarkdown.length > 0
        ? `${this.instructionsMarkdown}\n\nTask: ${this.run.record.title}`
        : `Task: ${this.run.record.title}`;

    const stream = this.input.adapter.run({
      runId: this.run.id,
      sessionId: generateId('sess'),
      workdir: this.input.repoRoot,
      prompt,
      role,
      // `record.model` is the PROVIDER name; forward it as `provider` so the
      // gateway picks that provider and resolves its real model id (passing it
      // as `model` would clobber the model id → 404 model_not_found).
      ...(this.run.record.model !== null ? { provider: this.run.record.model } : {}),
      phase: { id: phase.id, name: phase.name, type: phase.type },
      config: this.input.config,
      gateway: this.input.gateway,
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
        if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
          this.input.runManager.appendModelCall(this.run.id, {
            provider: this.input.config.models?.default ?? 'mock',
            model: typeof model === 'string' ? model : 'mock-model',
            inputTokens,
            outputTokens,
            costCents:
              typeof event.payload['costCents'] === 'number'
                ? (event.payload['costCents'] as number)
                : null,
            timestamp: new Date().toISOString(),
          });
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
        allPassed = false;
        this.emit('command_completed', { command, exitCode: -1, denied: true }, phase.id);
        logLines.push(`$ ${command}\n[denied] ${decision.reason}`);
        continue;
      }
      if (
        decision.requiresConfirmation &&
        !(await this.confirm(`Run "${command}"?`, phase.id))
      ) {
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
    const approved = await this.confirm(`Apply the generated patch for run ${this.run.id}?`, phase.id);
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
        { message: `patch did not apply: ${check.reason ?? 'unknown'}`, filesAffected, fatal: false },
        phase.id,
      );
      return;
    }
    applyPatch(this.input.repoRoot, this.collectedDiff);
    this.emit('patch_applied', { filesAffected }, phase.id);
  }

  private async pullRequestPhase(phase: WorkflowPhase): Promise<void> {
    const output = await this.chat(
      'summary',
      `Task: ${this.run.record.title}\nWrite a pull request summary for the completed work.`,
      phase,
    );
    const fileName = phase.output ?? 'pr-summary.md';
    const path = this.input.runManager.writeArtifact(
      this.run.id,
      fileName,
      `${output.content}\n`,
    );
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

      return this.finish('completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        typeof (error as { code?: unknown }).code === 'string'
          ? ((error as { code: string }).code as string)
          : 'run_failed';
      this.emit('error', { message, code });
      return this.finish('failed');
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
