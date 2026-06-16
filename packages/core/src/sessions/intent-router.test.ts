import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type ExcaliburConfig } from '@excalibur/shared';
import { buildStatusLineModel, classifyGoalIntent, parseStructuralInput } from './intent-router';

describe('classifyGoalIntent — explicit iterate-until-done detection (en+es)', () => {
  it('detects English "until it passes/works/done" goals', () => {
    expect(classifyGoalIntent('fix the parser and keep going until the tests pass').isGoal).toBe(
      true,
    );
    expect(classifyGoalIntent("don't stop until the build is green").isGoal).toBe(true);
    expect(classifyGoalIntent('iterate until it works').isGoal).toBe(true);
    expect(classifyGoalIntent('make sure all the tests pass').isGoal).toBe(true);
  });

  it('detects Spanish goals', () => {
    expect(classifyGoalIntent('arregla el bug y no pares hasta que pasen los tests').isGoal).toBe(
      true,
    );
    expect(classifyGoalIntent('sigue trabajando hasta que funcione').isGoal).toBe(true);
    expect(classifyGoalIntent('arréglalo del todo').isGoal).toBe(true);
  });

  it('returns the matched signal for the offer message', () => {
    const intent = classifyGoalIntent('please keep going until the tests pass');
    expect(intent.isGoal).toBe(true);
    expect(intent.signal.length).toBeGreaterThan(0);
    expect(intent.signal.toLowerCase()).toContain('until');
  });

  it('does NOT fire on ordinary one-shot requests (conservative)', () => {
    expect(classifyGoalIntent('fix the webhook retry bug').isGoal).toBe(false);
    expect(classifyGoalIntent('what does this function do?').isGoal).toBe(false);
    expect(classifyGoalIntent('add a test for parseConfig').isGoal).toBe(false);
    expect(classifyGoalIntent('explain the auth flow').isGoal).toBe(false);
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
