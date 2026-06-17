import { describe, expect, it } from 'vitest';
import {
  createEvent,
  excaliburEventSchema,
  excaliburEventTypeSchema,
  parseEventsJsonl,
  serializeEventLine,
  verificationPayloadSchema,
  type ExcaliburEvent,
} from './events';

describe('createEvent', () => {
  it('produces a contract-valid event with generated id and timestamp', () => {
    const event = createEvent({
      runId: 'run_20260612_143022',
      type: 'file_write',
      payload: { path: 'src/escrow/escrow.service.ts', operation: 'modify' },
    });
    expect(event.id).toMatch(/^evt_/);
    expect(event.runId).toBe('run_20260612_143022');
    expect(event.type).toBe('file_write');
    expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
    expect(excaliburEventSchema.safeParse(event).success).toBe(true);
  });

  it('defaults phaseId and sessionId to null and supports explicit attribution', () => {
    const bare = createEvent({ runId: null, type: 'error', payload: {} });
    expect(bare.phaseId).toBeNull();
    expect(bare.sessionId).toBeNull();
    expect(bare.runId).toBeNull();

    const attributed = createEvent({
      runId: 'run_1',
      type: 'phase_started',
      payload: {},
      phaseId: 'implement',
      sessionId: 'sess_1',
    });
    expect(attributed.phaseId).toBe('implement');
    expect(attributed.sessionId).toBe('sess_1');
  });

  it('supports all 27 pinned event types', () => {
    expect(excaliburEventTypeSchema.options).toHaveLength(27);
    expect(excaliburEventTypeSchema.options).toContain('compaction'); // the 24th (context compaction)
    expect(excaliburEventTypeSchema.options).toContain('task_update'); // the 25th (in-session checklist)
    expect(excaliburEventTypeSchema.options).toContain('verification'); // the 26th (mesh verdict)
    expect(excaliburEventTypeSchema.options).toContain('claim'); // the 27th (claim ledger)
    for (const type of excaliburEventTypeSchema.options) {
      const event = createEvent({ runId: 'run_1', type, payload: {} });
      expect(excaliburEventSchema.safeParse(event).success).toBe(true);
    }
  });
});

describe('verificationPayloadSchema', () => {
  it('validates a blocked Verification Mesh verdict with issues', () => {
    const parsed = verificationPayloadSchema.safeParse({
      blocked: true,
      lenses: ['correctness', 'security'],
      summary: 'Verification mesh (2 lens) — 1 high (BLOCKING).',
      issues: [
        { lens: 'security', severity: 'high', file: 'src/a.ts', problem: 'eval', fix: 'parse' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a clean verdict (no issues) and rejects a bad severity', () => {
    expect(
      verificationPayloadSchema.safeParse({
        blocked: false,
        lenses: ['correctness'],
        summary: 'clean',
        issues: [],
      }).success,
    ).toBe(true);
    expect(
      verificationPayloadSchema.safeParse({
        blocked: false,
        lenses: [],
        summary: 'x',
        issues: [{ lens: 'correctness', severity: 'critical', problem: 'p' }],
      }).success,
    ).toBe(false);
  });
});

describe('serializeEventLine / parseEventsJsonl round-trip', () => {
  it('round-trips a sequence of events through JSONL', () => {
    const events: ExcaliburEvent[] = [
      createEvent({ runId: 'run_1', type: 'run_started', payload: { title: 'Fix bug' } }),
      createEvent({
        runId: 'run_1',
        type: 'command_completed',
        payload: { command: 'pnpm test', simulated: true, exitCode: 0 },
        phaseId: 'verify',
      }),
      createEvent({ runId: 'run_1', type: 'run_completed', payload: { status: 'completed' } }),
    ];
    const jsonl = events.map(serializeEventLine).join('\n');
    expect(parseEventsJsonl(jsonl)).toEqual(events);
  });

  it('serializes to a single line without a trailing newline', () => {
    const line = serializeEventLine(
      createEvent({ runId: 'run_1', type: 'model_call', payload: { model: 'mock' } }),
    );
    expect(line.includes('\n')).toBe(false);
    expect(JSON.parse(line)).toMatchObject({ type: 'model_call' });
  });

  it('skips blank and whitespace-only lines', () => {
    const event = createEvent({ runId: 'run_1', type: 'tool_call', payload: {} });
    const jsonl = `\n  \n${serializeEventLine(event)}\n\n   \n`;
    const parsed = parseEventsJsonl(jsonl);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(event);
  });

  it('returns an empty array for empty content', () => {
    expect(parseEventsJsonl('')).toEqual([]);
    expect(parseEventsJsonl('\n\n')).toEqual([]);
  });

  it('reports the 1-based line number for invalid JSON lines', () => {
    const good = serializeEventLine(
      createEvent({ runId: 'run_1', type: 'file_read', payload: { path: 'README.md' } }),
    );
    expect(() => parseEventsJsonl(`${good}\n{not json`)).toThrowError(/line 2 is not valid JSON/);
  });

  it('reports the line number for schema-violating lines', () => {
    const good = serializeEventLine(
      createEvent({ runId: 'run_1', type: 'file_read', payload: { path: 'README.md' } }),
    );
    const badType = JSON.stringify({
      id: 'evt_x',
      runId: 'run_1',
      type: 'not_a_real_type',
      timestamp: new Date().toISOString(),
      payload: {},
    });
    expect(() => parseEventsJsonl(`${good}\n${good}\n${badType}`)).toThrowError(
      /line 3 does not match the Excalibur event contract/,
    );
  });

  it('rejects events with missing payload or bad timestamp', () => {
    const noPayload = JSON.stringify({
      id: 'evt_x',
      runId: 'run_1',
      type: 'error',
      timestamp: new Date().toISOString(),
    });
    expect(() => parseEventsJsonl(noPayload)).toThrowError(/line 1/);

    const badTimestamp = JSON.stringify({
      id: 'evt_x',
      runId: 'run_1',
      type: 'error',
      timestamp: 'yesterday',
      payload: {},
    });
    expect(() => parseEventsJsonl(badTimestamp)).toThrowError(/line 1/);
  });
});
