import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactRecordError } from '../errors';
import { makeTempDir, removeDir } from '../test-utils';
import { PROMPT_HISTORY_CAP, SessionStore } from './session-store';

describe('SessionStore', () => {
  let repoRoot: string;
  let store: SessionStore;

  beforeEach(() => {
    repoRoot = makeTempDir();
    store = new SessionStore(repoRoot);
  });

  afterEach(() => removeDir(repoRoot));

  it('reserves a timestamped session directory with a valid metadata.json', () => {
    const session = store.createSession({ title: 'My session' });
    expect(session.id).toMatch(/^sess_\d{8}_\d{6}$/);
    expect(session.dir).toBe(join(repoRoot, '.excalibur', 'sessions', session.id));
    expect(existsSync(join(session.dir, 'metadata.json'))).toBe(true);
    expect(existsSync(join(session.dir, 'transcript.jsonl'))).toBe(true);
    expect(session.metadata.status).toBe('active');
    expect(session.metadata.title).toBe('My session');
    expect(session.metadata.turnCount).toBe(0);
    expect(session.metadata.lastModel).toBeNull();
    expect(session.metadata.repoRoot).toBe(repoRoot);
  });

  it('round-trips turns through the JSONL transcript with stable ids and seqs', () => {
    const session = store.createSession();
    const user = store.appendTurn(session.id, { role: 'user', kind: 'message', text: 'hello' });
    const assistant = store.appendTurn(session.id, {
      role: 'assistant',
      kind: 'message',
      text: 'hi there',
      model: 'mock',
      costCents: 0,
      artifactRef: 'int_20260101_000000',
    });

    expect(user.id).toBe(`${session.id}:0`);
    expect(user.seq).toBe(0);
    expect(assistant.id).toBe(`${session.id}:1`);
    expect(assistant.seq).toBe(1);

    const turns = store.readTranscript(session.id);
    expect(turns.map((turn) => turn.text)).toEqual(['hello', 'hi there']);
    expect(turns[1]?.model).toBe('mock');
    expect(turns[1]?.artifactRef).toBe('int_20260101_000000');

    // Metadata reflects the appended turns.
    const reloaded = store.getSession(session.id);
    expect(reloaded.metadata.turnCount).toBe(2);
    expect(reloaded.metadata.lastModel).toBe('mock');
  });

  it('transcript reader tolerates a corrupt JSONL line', () => {
    const session = store.createSession();
    store.appendTurn(session.id, { role: 'user', kind: 'message', text: 'real turn' });
    const transcriptPath = join(session.dir, 'transcript.jsonl');
    writeFileSync(transcriptPath, `${readFileSync(transcriptPath, 'utf8')}{ not json\n`, 'utf8');
    const turns = store.readTranscript(session.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toBe('real turn');
  });

  it('lists and resolves the latest session; listing tolerates corrupt entries', () => {
    const first = store.createSession({ title: 'first' });
    const second = store.createSession({ title: 'second' });
    // Corrupt a third session's metadata.
    const corrupt = store.createSession({ title: 'corrupt' });
    writeFileSync(join(corrupt.dir, 'metadata.json'), '{ broken', 'utf8');

    const ids = store.listSessions().map((session) => session.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    expect(ids).not.toContain(corrupt.id);

    // latestSession ignores the corrupt entry and returns the newest valid one.
    const latest = store.latestSession();
    expect(latest?.id).toBe(second.id);
  });

  it('updateMetadata merges and persists a status change', () => {
    const session = store.createSession();
    const updated = store.updateMetadata(session.id, { status: 'closed', title: 'renamed' });
    expect(updated.metadata.status).toBe('closed');
    expect(updated.metadata.title).toBe('renamed');
    expect(store.getSession(session.id).metadata.status).toBe('closed');
  });

  it('getSession throws for an unknown id', () => {
    expect(() => store.getSession('sess_19990101_000000')).toThrow(ArtifactRecordError);
  });

  it('rejects a malformed metadata.json on read', () => {
    const session = store.createSession();
    writeFileSync(
      join(session.dir, 'metadata.json'),
      JSON.stringify({ id: session.id, status: 'paused' }),
      'utf8',
    );
    expect(() => store.getSession(session.id)).toThrow(ArtifactRecordError);
  });
});

describe('SessionStore prompt history', () => {
  let repoRoot: string;
  let store: SessionStore;

  beforeEach(() => {
    repoRoot = makeTempDir();
    store = new SessionStore(repoRoot);
  });

  afterEach(() => removeDir(repoRoot));

  it('appends submitted prompts and loads them oldest-first', () => {
    store.appendPromptHistory('first prompt');
    store.appendPromptHistory('second prompt');
    expect(store.loadPromptHistory()).toEqual(['first prompt', 'second prompt']);
  });

  it('dedupes adjacent duplicates and skips empty lines', () => {
    store.appendPromptHistory('same');
    store.appendPromptHistory('same');
    store.appendPromptHistory('   ');
    store.appendPromptHistory('different');
    store.appendPromptHistory('same');
    expect(store.loadPromptHistory()).toEqual(['same', 'different', 'same']);
  });

  it('caps the history at PROMPT_HISTORY_CAP entries', () => {
    for (let i = 0; i < PROMPT_HISTORY_CAP + 50; i += 1) {
      store.appendPromptHistory(`prompt ${i}`);
    }
    const history = store.loadPromptHistory();
    expect(history.length).toBe(PROMPT_HISTORY_CAP);
    // The newest entries survive; the oldest are dropped.
    expect(history[history.length - 1]).toBe(`prompt ${PROMPT_HISTORY_CAP + 49}`);
    expect(history[0]).toBe(`prompt 50`);
  });

  it('returns an empty history when none has been written', () => {
    expect(store.loadPromptHistory()).toEqual([]);
  });

  it('restricts the history file to owner-only (0600)', () => {
    store.appendPromptHistory('a personal prompt');
    const mode = statSync(join(repoRoot, '.excalibur', 'sessions', 'history')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
