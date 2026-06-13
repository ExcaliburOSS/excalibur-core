import { describe, expect, it } from 'vitest';
import { localRunSchema, RUN_ARTIFACT_FILES, runRecordSchema, type RunRecord } from './artifacts';

const validRecord: RunRecord = {
  id: 'run_20260612_143022',
  title: 'Fix duplicated escrow release',
  autonomyLevel: 3,
  workflow: 'fast-fix',
  methodology: 'fast-fix',
  status: 'completed',
  model: 'qwen',
  executionStyle: 'fast',
  startedAt: '2026-06-12T14:30:22Z',
  completedAt: '2026-06-12T14:34:10Z',
};

describe('runRecordSchema', () => {
  it('accepts the OSS spec §11 run.json shape (with extra nullable fields)', () => {
    const result = runRecordSchema.safeParse(validRecord);
    expect(result.success).toBe(true);
  });

  it('accepts null methodology, model, executionStyle and completedAt', () => {
    const result = runRecordSchema.safeParse({
      ...validRecord,
      methodology: null,
      model: null,
      executionStyle: null,
      completedAt: null,
      status: 'running',
    });
    expect(result.success).toBe(true);
  });

  it('accepts timestamps with explicit UTC offsets', () => {
    const result = runRecordSchema.safeParse({
      ...validRecord,
      startedAt: '2026-06-12T16:30:22+02:00',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown status', () => {
    const result = runRecordSchema.safeParse({ ...validRecord, status: 'paused' });
    expect(result.success).toBe(false);
  });

  it('rejects an out-of-range autonomy level', () => {
    expect(runRecordSchema.safeParse({ ...validRecord, autonomyLevel: 5 }).success).toBe(false);
    expect(runRecordSchema.safeParse({ ...validRecord, autonomyLevel: -1 }).success).toBe(false);
  });

  it('rejects non-ISO startedAt values', () => {
    const result = runRecordSchema.safeParse({ ...validRecord, startedAt: '12/06/2026 14:30' });
    expect(result.success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const { id: _id, ...withoutId } = validRecord;
    expect(runRecordSchema.safeParse(withoutId).success).toBe(false);
    expect(runRecordSchema.safeParse({ ...validRecord, title: '' }).success).toBe(false);
  });
});

describe('localRunSchema', () => {
  it('validates a LocalRun shape', () => {
    const result = localRunSchema.safeParse({
      id: validRecord.id,
      dir: `.excalibur/runs/${validRecord.id}`,
      record: validRecord,
    });
    expect(result.success).toBe(true);
  });
});

describe('RUN_ARTIFACT_FILES', () => {
  it('lists exactly the 13 pinned artifact file names', () => {
    expect(RUN_ARTIFACT_FILES).toEqual([
      'run.json',
      'workflow.yaml',
      'methodology.yaml',
      'events.jsonl',
      'model-calls.jsonl',
      'input.md',
      'context.md',
      'diff.patch',
      'summary.md',
      'review.md',
      'test-results.json',
      'tests.log',
      'pr-summary.md',
    ]);
  });
});
