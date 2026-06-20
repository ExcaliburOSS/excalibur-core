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
  'task_update',
  'verification',
  'claim',
  'diagnostics',
  'provenance',
  'network_egress',
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

/** A single item in the agent's in-session checklist (the `task_update` event). */
export const taskItemSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
});
export type TaskItem = z.infer<typeof taskItemSchema>;

/**
 * Payload of a `task_update` event (event #25): a full SNAPSHOT of the agent's
 * live checklist for the current request — last snapshot wins. Modeled as an
 * event (not ephemeral UI state) so the checklist is replayable, forkable and
 * auditable, which Claude Code's TodoWrite is not.
 */
export const taskUpdatePayloadSchema = z.object({ tasks: z.array(taskItemSchema) });
export type TaskUpdatePayload = z.infer<typeof taskUpdatePayloadSchema>;

/** A single adversarial finding within a `verification` event. */
export const verificationIssueSchema = z.object({
  lens: z.string(),
  severity: z.enum(['high', 'medium', 'low']),
  file: z.string().optional(),
  problem: z.string(),
  fix: z.string().optional(),
});
export type VerificationIssue = z.infer<typeof verificationIssueSchema>;

/**
 * Payload of a `verification` event (event #26): the verdict of the adversarial
 * Verification Mesh over a run's diff. A first-class event (not overloaded onto
 * `error`/`test_result`) so the verdict is replayable, forkable and auditable,
 * and Enterprise can map it to its own audit type. `blocked: true` means a
 * surviving HIGH-severity issue gated the run from `completed` (→ needs-fix).
 */
export const verificationPayloadSchema = z.object({
  blocked: z.boolean(),
  lenses: z.array(z.string()),
  issues: z.array(verificationIssueSchema),
  summary: z.string(),
});
export type VerificationPayload = z.infer<typeof verificationPayloadSchema>;

/**
 * Payload of a `claim` event (event #27): one entry of the CLAIM LEDGER. A claim
 * the model made (or the run implies) about its work — `tests_pass`,
 * `no_type_errors`, `no_secrets`, `builds`, `requirement_met` — AUTO-VERIFIED
 * against real tool evidence (test exit codes, typecheck, a secret scan of the
 * diff) and stamped verified|refuted|unverified. `asserted` = the model actually
 * claimed it; a `refuted` + `asserted` claim is the model LYING — that blocks the
 * run. Evidence-linked + replayable → leapfrogs an LLM-judge grader.
 */
export const claimPayloadSchema = z.object({
  kind: z.string(),
  statement: z.string(),
  status: z.enum(['verified', 'refuted', 'unverified']),
  /** Did the model itself assert this (vs. an implied run-level claim)? */
  asserted: z.boolean(),
  /** What was checked + the result (e.g. "test command exit 1"). */
  evidence: z.string().optional(),
});
export type ClaimPayload = z.infer<typeof claimPayloadSchema>;

/**
 * Payload of a `diagnostics` event (event #28): real compiler diagnostics from a
 * Language Server for a file the agent JUST edited (P1.10 / M3). Emitted after a
 * `write_file`/`apply_patch`; the same errors are fed back to the model so it
 * self-corrects on the next turn. Lines/columns are 1-based (human/editor
 * convention; converted from LSP's 0-based positions).
 */
export const diagnosticItemSchema = z.object({
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  severity: z.enum(['error', 'warning', 'info', 'hint']),
  message: z.string(),
  code: z.string().optional(),
});
export type DiagnosticItem = z.infer<typeof diagnosticItemSchema>;

export const diagnosticsPayloadSchema = z.object({
  /** Repo-relative path of the edited file. */
  file: z.string(),
  diagnostics: z.array(diagnosticItemSchema),
  errorCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
});
export type DiagnosticsPayload = z.infer<typeof diagnosticsPayloadSchema>;

/**
 * Payload of a `provenance` event (event #29, F8): the audited record of one
 * piece of UNTRUSTED inbound content (a fetched page / MCP output) the model saw
 * — its source, URL, content hash, and prompt-injection verdict. Gives a run a
 * verifiable trail of every external source and whether it was flagged/quarantined.
 */
export const provenancePayloadSchema = z.object({
  source: z.enum(['web_fetch', 'web_search', 'web_extract', 'web_crawl', 'research', 'mcp']),
  url: z.string().optional(),
  /** sha256 of the original fetched content. */
  contentHash: z.string(),
  fetchedAt: z.string(),
  verdict: z.enum(['clean', 'suspicious', 'malicious']),
  signals: z.array(z.string()),
  /** True when the content was quarantined out of the model context. */
  blocked: z.boolean(),
});
export type ProvenancePayload = z.infer<typeof provenancePayloadSchema>;

/**
 * Payload of a `network_egress` event (event #30, F8): the audit trail of an
 * agent-initiated outbound network call — which tool, the target, and the policy
 * decision. Complements `provenance` (which audits the CONTENT) by auditing the
 * EGRESS itself (including searches and denied attempts that fetch no content).
 */
export const networkEgressPayloadSchema = z.object({
  tool: z.string(),
  /** The target URL or, for search/research, the query. */
  target: z.string(),
  decision: z.enum(['allow', 'deny']),
});
export type NetworkEgressPayload = z.infer<typeof networkEgressPayloadSchema>;

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
