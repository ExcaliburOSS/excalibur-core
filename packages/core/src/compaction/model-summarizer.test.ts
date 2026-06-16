import { describe, expect, it } from 'vitest';
import type { ChatOutput, GatewayChatInput } from '@excalibur/model-gateway';
import type { SessionTurn } from '../sessions/session-store';
import { projectTranscript } from './transcript';
import { compactAsync } from './compactor';
import { createModelSummarizer, type SummarizerChat } from './model-summarizer';
import { DEFAULT_COMPACTION_CONFIG } from './types';

function turn(seq: number, role: SessionTurn['role'], text: string): SessionTurn {
  return { id: `s:${seq}`, seq, role, kind: 'message', text, at: '2026-06-16T12:00:00.000Z' };
}

/** A fake chat that returns scripted content and records every input it received. */
function fakeChat(content: string, captured: GatewayChatInput[] = []): SummarizerChat {
  return {
    chat: (input: GatewayChatInput): Promise<ChatOutput> => {
      captured.push(input);
      return Promise.resolve({
        content,
        model: 'fake',
        usage: { inputTokens: 1, outputTokens: 1 },
        costCents: 0,
        finishReason: 'stop',
      });
    },
  };
}

const ENTRIES = projectTranscript([
  turn(0, 'user', 'Build a login form'),
  turn(1, 'assistant', 'Added auth route'),
  turn(2, 'user', 'now wire the DB'),
]).entries;

describe('createModelSummarizer', () => {
  it('parses a clean JSON response into a structured summary', async () => {
    const summarize = createModelSummarizer({ chat: fakeChat(
      JSON.stringify({
        summary: 'Built a login form and wired auth.',
        objective: 'Add authentication',
        decisions: ['chose JWT over sessions'],
        filesTouched: ['src/auth/login.ts'],
        pending: ['wire the database'],
      }),
    ) });
    const { summary, structuredSummary } = await summarize(ENTRIES);
    expect(summary).toBe('Built a login form and wired auth.');
    expect(structuredSummary.objective).toBe('Add authentication');
    expect(structuredSummary.decisions).toEqual(['chose JWT over sessions']);
    expect(structuredSummary.filesTouched).toEqual(['src/auth/login.ts']);
    expect(structuredSummary.pending).toEqual(['wire the database']);
    // condensed is computed deterministically from the entries, not the model.
    expect(structuredSummary.condensed).toEqual({ entries: 3, userTurns: 2, assistantTurns: 1 });
  });

  it('tolerates JSON wrapped in code fences / prose', async () => {
    const summarize = createModelSummarizer({ chat: fakeChat(
      'Here is the summary:\n```json\n{"summary":"S","objective":"O","decisions":[],"filesTouched":[],"pending":[]}\n```\n',
    ) });
    const { summary, structuredSummary } = await summarize(ENTRIES);
    expect(summary).toBe('S');
    expect(structuredSummary.objective).toBe('O');
  });

  it('degrades to a prose-only summary when there is no JSON', async () => {
    const summarize = createModelSummarizer({ chat: fakeChat('The user built a login form; DB still pending.') });
    const { summary, structuredSummary } = await summarize(ENTRIES);
    expect(summary).toBe('The user built a login form; DB still pending.');
    expect(structuredSummary.objective).toBe('');
    expect(structuredSummary.decisions).toEqual([]);
    expect(structuredSummary.condensed.entries).toBe(3);
  });

  it('salvages the prose summary from TRUNCATED JSON (no closing brace)', async () => {
    // The model started a JSON object but ran out of tokens mid-array.
    const truncated =
      '{"summary":"Built the login form and chose JWT.","objective":"Add auth","decisions":["chose JWT","added refresh tokens';
    const summarize = createModelSummarizer({ chat: fakeChat(truncated) });
    const { summary, structuredSummary } = await summarize(ENTRIES);
    expect(summary).toBe('Built the login form and chose JWT.'); // prose salvaged, not the raw blob
    expect(summary).not.toContain('{'); // never the raw JSON
    expect(structuredSummary.condensed.entries).toBe(3);
  });

  it('throws on empty content so the caller can fall back to the offline default', async () => {
    const summarize = createModelSummarizer({ chat: fakeChat('   ') });
    await expect(summarize(ENTRIES)).rejects.toThrow(/empty/i);
  });

  it('redacts secrets from the summary AND structured fields', async () => {
    const secret = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const summarize = createModelSummarizer({ chat: fakeChat(
      JSON.stringify({
        summary: `Configured the key ${secret} in the client.`,
        objective: `Use ${secret}`,
        decisions: [`store ${secret}`],
        filesTouched: [],
        pending: [],
      }),
    ) });
    const { summary, structuredSummary } = await summarize(ENTRIES);
    expect(summary).not.toContain(secret);
    expect(summary).toContain('[REDACTED]');
    expect(structuredSummary.objective).not.toContain(secret);
    expect(structuredSummary.decisions[0]).not.toContain(secret);
  });

  it('routes to the configured provider and sends a redacted, role-tagged transcript', async () => {
    const captured: GatewayChatInput[] = [];
    const secret = 'sk-ZYXWVUTSRQPONMLKJIHGFEDCBA987654';
    const entries = projectTranscript([turn(0, 'user', `my key is ${secret}`)]).entries;
    const summarize = createModelSummarizer({
      chat: fakeChat('{"summary":"ok","objective":"","decisions":[],"filesTouched":[],"pending":[]}', captured),
      provider: 'groq-cheap',
      locale: 'es',
    });
    await summarize(entries);
    expect(captured[0]!.provider).toBe('groq-cheap');
    expect(captured[0]!.metadata).toMatchObject({ kind: 'compact' });
    const userMsg = captured[0]!.messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('[user]');
    // The secret never leaves for the model.
    expect(userMsg?.content).not.toContain(secret);
    // Spanish locale instruction reaches the system prompt.
    const sysMsg = captured[0]!.messages.find((m) => m.role === 'system');
    expect(sysMsg?.content).toContain('Spanish');
  });
});

describe('compactAsync', () => {
  const turns: SessionTurn[] = [
    turn(0, 'user', 'x'.repeat(400)),
    turn(1, 'assistant', 'y'.repeat(400)),
    turn(2, 'user', 'z'.repeat(40)),
  ];

  it('returns null when nothing needs compacting (under budget)', async () => {
    const transcript = projectTranscript(turns);
    const result = await compactAsync(transcript, {
      config: { ...DEFAULT_COMPACTION_CONFIG, reserveTokens: 0, keepRecentTokens: 20 },
      contextWindow: 1_000_000, // huge → under budget
      summarize: () => Promise.resolve({ summary: 'unused', structuredSummary: { objective: '', decisions: [], filesTouched: [], pending: [], condensed: { entries: 0, userTurns: 0, assistantTurns: 0 } } }),
    });
    expect(result).toBeNull();
  });

  it('builds a record from the async summarizer (forced), redacting the prose summary', async () => {
    const transcript = projectTranscript(turns);
    const record = await compactAsync(transcript, {
      // Small recent tail so the older turn(s) become a summarizable prefix.
      config: { ...DEFAULT_COMPACTION_CONFIG, keepRecentTokens: 20 },
      contextWindow: 1_000_000,
      model: 'groq:openai/gpt-oss-120b',
      force: true,
      summarize: (entries) =>
        Promise.resolve({
          summary: 'Compacted summary with a key sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345.',
          structuredSummary: { objective: 'O', decisions: ['d'], filesTouched: ['f.ts'], pending: ['p'], condensed: { entries: entries.length, userTurns: 0, assistantTurns: 0 } },
        }),
    });
    expect(record).not.toBeNull();
    expect(record!.summary).toContain('[REDACTED]');
    expect(record!.structuredSummary.objective).toBe('O');
    expect(record!.model).toBe('groq:openai/gpt-oss-120b');
    expect(record!.firstKeptEntryId).not.toBeNull();
    expect(record!.details.summarizedEntryIds.length).toBeGreaterThan(0);
  });
});
