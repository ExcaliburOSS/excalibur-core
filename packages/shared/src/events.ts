import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Canonical Excalibur event format (OSS spec §12).
 *
 * This is THE shared contract between Excalibur Core and Excalibur Enterprise:
 * local runs write these events to `.excalibur/runs/<run-id>/events.jsonl` and
 * Enterprise ingests the exact same shape (mapping `type` onto its AgentEvent
 * enum while preserving the original value in `payload.sourceType`).
 *
 * Changing or removing an event type is a breaking change for Enterprise ingestion.
 */
export const excaliburEventTypeSchema = z.enum([
  'run_started',
  'run_completed',
  'workflow_selected',
  'methodology_selected',
  'phase_started',
  'phase_completed',
  'assistant_message',
  'model_call',
  'tool_call',
  'file_read',
  'file_write',
  'command_started',
  'command_completed',
  'test_result',
  'patch_generated',
  'patch_applied',
  'branch_created',
  'approval_requested',
  'approval_approved',
  'approval_rejected',
  'policy_decision',
  'error',
  'artifact_created',
  'compaction',
]);
export type ExcaliburEventType = z.infer<typeof excaliburEventTypeSchema>;

export const excaliburEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1).nullable(),
  type: excaliburEventTypeSchema,
  timestamp: z.string().datetime({ offset: true }),
  /** Optional attribution, used by multi-phase / multi-session runs. */
  phaseId: z.string().min(1).nullish(),
  sessionId: z.string().min(1).nullish(),
  payload: z.record(z.unknown()),
});
export type ExcaliburEvent = z.infer<typeof excaliburEventSchema>;

export interface CreateEventInput {
  runId: string | null;
  type: ExcaliburEventType;
  payload: Record<string, unknown>;
  phaseId?: string | null;
  sessionId?: string | null;
}

export function createEvent(input: CreateEventInput): ExcaliburEvent {
  return {
    id: `evt_${randomUUID()}`,
    runId: input.runId,
    type: input.type,
    timestamp: new Date().toISOString(),
    phaseId: input.phaseId ?? null,
    sessionId: input.sessionId ?? null,
    payload: input.payload,
  };
}

/** Serializes an event as a single JSONL line (no trailing newline). */
export function serializeEventLine(event: ExcaliburEvent): string {
  return JSON.stringify(event);
}

/**
 * Parses an `events.jsonl` document. Throws a ZodError (with the offending line
 * number attached to the message) when a line does not match the contract.
 */
export function parseEventsJsonl(content: string): ExcaliburEvent[] {
  const events: ExcaliburEvent[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`events.jsonl line ${i + 1} is not valid JSON: ${(error as Error).message}`);
    }
    const result = excaliburEventSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `events.jsonl line ${i + 1} does not match the Excalibur event contract: ${result.error.message}`,
      );
    }
    events.push(result.data);
  }
  return events;
}
