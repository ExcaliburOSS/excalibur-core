import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type ExcaliburConfig } from '@excalibur/shared';
import {
  buildIntentPrompt,
  buildStatusLineModel,
  classifyTurnIntent,
  parseStructuralInput,
  parseTurnIntent,
  type IntentContext,
} from './intent-router';

const live: IntentContext = { interactive: true, mock: false, level: 4 };

describe('classifyTurnIntent — LLM-based, multi-language (no keyword/regex)', () => {
  it('routes via the injected model regardless of input language', async () => {
    const plan = vi.fn().mockResolvedValue('plan');
    // A French build request classifies correctly with NO en/es keywords involved.
    expect(await classifyTurnIntent('implémente un limiteur de débit', live, plan)).toBe('plan');
    expect(plan).toHaveBeenCalledOnce();
    expect(plan.mock.calls[0]?.[0]).toContain('implémente un limiteur de débit');

    const research = vi.fn().mockResolvedValue('research');
    expect(
      await classifyTurnIntent('quelles sont les nouveautés de React 19 ?', live, research),
    ).toBe('research');

    const goal = vi.fn().mockResolvedValue('goal');
    expect(await classifyTurnIntent('continue jusqu’à ce que les tests passent', live, goal)).toBe(
      'goal',
    );
  });

  it('falls back to chat (no model call) for mock / non-interactive / read-only / empty', async () => {
    const model = vi.fn().mockResolvedValue('plan');
    expect(await classifyTurnIntent('build it', { ...live, mock: true }, model)).toBe('chat');
    expect(await classifyTurnIntent('build it', { ...live, interactive: false }, model)).toBe(
      'chat',
    );
    expect(await classifyTurnIntent('build it', { ...live, level: 1 }, model)).toBe('chat');
    expect(await classifyTurnIntent('   ', live, model)).toBe('chat');
    expect(model).not.toHaveBeenCalled();
  });

  it('falls back to chat when the classifier throws/times out', async () => {
    const model = vi.fn().mockRejectedValue(new Error('timeout'));
    expect(await classifyTurnIntent('refactor the auth module', live, model)).toBe('chat');
  });
});

describe('parseTurnIntent', () => {
  it('maps the model answer to a category; unknown → chat', () => {
    expect(parseTurnIntent('plan')).toBe('plan');
    expect(parseTurnIntent('  RESEARCH\n')).toBe('research');
    expect(parseTurnIntent('Category: bg')).toBe('bg');
    expect(parseTurnIntent('je ne sais pas')).toBe('chat');
    expect(parseTurnIntent('')).toBe('chat');
  });
});

describe('buildIntentPrompt', () => {
  it('embeds the request verbatim and is language-agnostic', () => {
    const prompt = buildIntentPrompt('faça em segundo plano');
    expect(prompt).toContain('faça em segundo plano');
    expect(prompt).toContain('ANY language');
  });
});

describe('parseStructuralInput — structural recognition only (model-first)', () => {
  it('routes a leading / to a slash command with argv', () => {
    const decision = parseStructuralInput('/resume sess_20260101_000000');
    expect(decision).toEqual({ kind: 'command', name: 'resume', argv: ['sess_20260101_000000'] });
  });

  it('lowercases the command name and respects quotes in argv', () => {
    const decision = parseStructuralInput('/Model "gpt 4o"');
    expect(decision).toEqual({ kind: 'command', name: 'model', argv: ['gpt 4o'] });
  });

  it('parses a /plan command with the task as argv', () => {
    const decision = parseStructuralInput('/plan add retry to the fetch transport');
    expect(decision).toEqual({
      kind: 'command',
      name: 'plan',
      argv: ['add', 'retry', 'to', 'the', 'fetch', 'transport'],
    });
  });

  it('routes a leading ! to a shell passthrough', () => {
    const decision = parseStructuralInput('!ls -la');
    expect(decision).toEqual({ kind: 'shell', command: 'ls -la' });
  });

  it('treats everything else as a natural-language turn (handed to the model)', () => {
    // No keyword classification — a question, a task and an idea are all just
    // `natural` turns; the MODEL (the agent loop) decides what to do with them.
    for (const text of [
      'How does the run pipeline select a workflow?',
      'Add a retry with backoff to the fetch transport',
      'the whole onboarding experience',
      'arregla el bug de expiración de sesión', // any language
    ]) {
      expect(parseStructuralInput(text)).toEqual({ kind: 'natural', text: text.trim() });
    }
  });

  it('trims surrounding whitespace on a natural-language turn', () => {
    expect(parseStructuralInput('   review the diff   ')).toEqual({
      kind: 'natural',
      text: 'review the diff',
    });
  });

  it('is purely deterministic (never calls a model — stable across calls)', () => {
    const a = parseStructuralInput('Add pagination to the logs command');
    const b = parseStructuralInput('Add pagination to the logs command');
    expect(a).toEqual(b);
  });
});

describe('buildStatusLineModel', () => {
  it('derives autonomy / model / safety / cost from the config', () => {
    const model = buildStatusLineModel({
      config: DEFAULT_CONFIG,
      model: 'mock',
      costCents: 12,
      autonomyLevel: 3,
      workflow: 'fast-fix',
    });
    expect(model).toEqual({
      autonomy: 'L3 Branch',
      workflow: 'fast-fix',
      model: 'mock',
      costCents: 12,
      safety: 'standard-safe',
    });
  });

  it('falls back to the default safety preset when the config names an unknown one', () => {
    const config: ExcaliburConfig = { ...DEFAULT_CONFIG, safety: { preset: 'does-not-exist' } };
    const model = buildStatusLineModel({ config, model: 'mock' });
    expect(model.safety).toBe('standard-safe');
    // Defaults: cost 0, workflow placeholder.
    expect(model.costCents).toBe(0);
    expect(model.workflow).toBe('conversation');
  });

  it('uses the config autonomy default when no level is supplied', () => {
    const config: ExcaliburConfig = { ...DEFAULT_CONFIG, autonomy: { default: 1 } };
    const model = buildStatusLineModel({ config, model: 'mock' });
    expect(model.autonomy).toBe('L1 Assist');
  });
});
