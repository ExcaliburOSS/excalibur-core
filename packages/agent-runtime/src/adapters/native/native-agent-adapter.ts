import {
  createEvent,
  type AgentRole,
  type ExcaliburEvent,
  type ExcaliburEventType,
} from '@excalibur/shared';
import type { ChatMessage, ChatOutput } from '@excalibur/model-gateway';
import { NATIVE_TOOL_NAMES } from '../../tools/native-tools';
import type { AgentAdapter, AgentRunInput } from '../../types';

/**
 * Native agent adapter — M1 behavior (Build Contract §4.4).
 *
 * In M1 the adapter produces a scripted, realistic event stream for the phase
 * and NEVER touches the user's filesystem: file/command/test events carry
 * `simulated: true` payloads, and the generated mock diff travels inside the
 * `patch_generated` payload as `{ diff, filesAffected }` instead of being
 * applied. Assistant text comes from the model gateway (MockProvider in M1).
 * The real tool loop (OSS-7) arrives in M2.
 */

const DEFAULT_TARGET_FILE = 'src/example.service.ts';
const MAX_TARGET_FILES = 3;
const DEFAULT_TEST_COMMAND = 'npm test';

/** Same path detection the MockProvider uses (Build Contract §7). */
const FILE_PATH_PATTERN = /[\w./-]+\.(?:ts|js|tsx|py|go|rb|java)\b/g;

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

/** Extracts repository file paths mentioned in the prompt (max 3, deduped). */
function detectTargetPaths(prompt: string): string[] {
  const matches = prompt.match(FILE_PATH_PATTERN) ?? [];
  const unique: string[] = [];
  for (const match of matches) {
    const normalized = match.replace(/^\.\/+/, '').replace(/^\/+/, '');
    if (normalized.length > 0 && !unique.includes(normalized)) {
      unique.push(normalized);
    }
  }
  return unique.slice(0, MAX_TARGET_FILES);
}

/** Pulls the unified diff out of the MockProvider's ```diff fenced block. */
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

/**
 * Deterministic local fallback diff, used only when the gateway response does
 * not contain a parseable ```diff block (e.g. a custom provider in tests).
 * Shape mirrors the MockProvider's plausible idempotency guard-clause fix.
 */
function buildFallbackDiff(paths: string[]): string {
  const targets = paths.length > 0 ? paths : [DEFAULT_TARGET_FILE];
  const sections = targets.map((filePath) =>
    [
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      '@@ -10,6 +10,10 @@',
      '   async handle(id: string): Promise<void> {',
      '     const record = await this.repository.findById(id);',
      '',
      "+    if (record.processedAt !== null) {",
      '+      // Idempotency guard: repeated handling must be a no-op.',
      '+      return;',
      '+    }',
      '     record.processedAt = new Date();',
      '     await this.repository.save(record);',
      '   }',
    ].join('\n'),
  );
  return sections.join('\n');
}

function systemPromptFor(input: AgentRunInput): string {
  const phase =
    input.phase !== undefined
      ? ` for phase "${input.phase.name}" (${input.phase.type})`
      : '';
  return [
    `You are the Excalibur native agent acting as the "${input.role}" role${phase}.`,
    `Working directory: ${input.workdir}.`,
    'Respond with concise, actionable markdown.',
  ].join('\n');
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

  /**
   * M1 no-op stop: the scripted stream is short-lived, so stopping only
   * records the session id (real cancellation lands with the M2 tool loop).
   */
  stop(sessionId: string): Promise<void> {
    this.stoppedSessions.add(sessionId);
    return Promise.resolve();
  }

  /**
   * Scripted M1 stream, in the contract-pinned order:
   * tool_call → file_read → model_call → file_write →
   * command_started/command_completed (`simulated: true`) →
   * test_result (passed) → patch_generated (implementer only).
   */
  async *run(input: AgentRunInput): AsyncIterable<ExcaliburEvent> {
    const event = (
      type: ExcaliburEventType,
      payload: Record<string, unknown>,
    ): ExcaliburEvent =>
      createEvent({
        runId: input.runId,
        type,
        payload,
        phaseId: input.phase?.id ?? null,
        sessionId: input.sessionId,
      });

    const targets = detectTargetPaths(input.prompt);
    const primaryTarget = targets[0] ?? DEFAULT_TARGET_FILE;
    const responseKind = ROLE_TO_RESPONSE_KIND[input.role] ?? 'ask';

    yield event('tool_call', {
      tool: 'read_file',
      arguments: { path: primaryTarget },
      simulated: true,
    });
    yield event('file_read', { path: primaryTarget, simulated: true });

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPromptFor(input) },
      { role: 'user', content: input.prompt },
    ];
    const chatInput: Parameters<AgentRunInput['gateway']['chat']>[0] = {
      messages,
      metadata: {
        kind: responseKind,
        role: input.role,
        runId: input.runId,
        phaseId: input.phase?.id ?? null,
      },
    };
    if (input.model !== undefined) {
      chatInput.model = input.model;
    }
    const output: ChatOutput = await input.gateway.chat(chatInput);

    yield event('model_call', {
      model: output.model,
      kind: responseKind,
      inputTokens: output.usage.inputTokens,
      outputTokens: output.usage.outputTokens,
      costCents: output.costCents,
      finishReason: output.finishReason,
      content: output.content,
      simulated: true,
    });

    yield event('file_write', {
      path: primaryTarget,
      operation: 'modify',
      simulated: true,
    });

    const command = input.config.commands?.test ?? DEFAULT_TEST_COMMAND;
    yield event('command_started', { command, simulated: true });
    yield event('command_completed', { command, simulated: true, exitCode: 0 });
    yield event('test_result', { status: 'passed', simulated: true, command });

    if (input.role === 'implementer') {
      const diff = extractUnifiedDiff(output.content) ?? buildFallbackDiff(targets);
      yield event('patch_generated', {
        diff,
        filesAffected: filesAffectedFromDiff(diff),
      });
    }
  }
}
