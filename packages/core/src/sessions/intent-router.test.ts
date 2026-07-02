import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type ExcaliburConfig } from '@excalibur/shared';
import {
  buildIntentPrompt,
  buildScheduleExtractionPrompt,
  buildStatusLineModel,
  classifyOrchestrationAction,
  classifyScheduleExtraction,
  classifyTurnIntent,
  parseOrchestrationAction,
  parseScheduleExtraction,
  decidePosture,
  parseStructuralInput,
  parseTurnConfidence,
  parseTurnDecision,
  parseTurnIntent,
  riskOfShape,
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
    expect(parseTurnIntent('schedule')).toBe('schedule'); // AO8-4
    expect(parseTurnIntent('mission')).toBe('mission'); // meta-orchestrator route (M6)
    expect(parseTurnIntent('scope')).toBe('scope'); // AO9-3 understand-first route
    expect(parseTurnIntent('edit')).toBe('edit'); // RUN-FIX-10 small-change route
  });

  it('prefers the LAST recognized label, skipping confidence words and stray prose (RUN-FIX-10)', () => {
    // The decision format is "<category> <confidence>": the confidence word is not
    // an intent, so the category still wins.
    expect(parseTurnIntent('edit high')).toBe('edit');
    expect(parseTurnIntent('chat low')).toBe('chat');
    // A reasoning model may mention a category word in its prose before the final
    // label; the trailing label must win over the earlier stray mention.
    expect(parseTurnIntent('the user wants to chat about a refactor, so: edit high')).toBe('edit');
    expect(parseTurnIntent('this looks like an edit but is really a question — chat')).toBe('chat');
  });
});

describe('parseTurnConfidence / parseTurnDecision (AO3d-2)', () => {
  it('extracts the confidence word; unknown → medium', () => {
    expect(parseTurnConfidence('swarm high')).toBe('high');
    expect(parseTurnConfidence('chat low')).toBe('low');
    expect(parseTurnConfidence('plan')).toBe('medium');
  });
  it('parses category + confidence together', () => {
    expect(parseTurnDecision('swarm high')).toEqual({ intent: 'swarm', confidence: 'high' });
    expect(parseTurnDecision('research medium')).toEqual({
      intent: 'research',
      confidence: 'medium',
    });
    expect(parseTurnDecision('nonsense')).toEqual({ intent: 'chat', confidence: 'medium' });
  });
});

describe('riskOfShape (AO3d-2, pure)', () => {
  it('scores reversibility/impact per shape', () => {
    expect(riskOfShape('chat')).toBe('low');
    expect(riskOfShape('research')).toBe('low');
    expect(riskOfShape('plan')).toBe('medium');
    expect(riskOfShape('swarm')).toBe('medium');
    expect(riskOfShape('bg')).toBe('medium');
    expect(riskOfShape('goal')).toBe('high');
    expect(riskOfShape('explore')).toBe('high'); // best-of-N is a cost amplifier
    expect(riskOfShape('orchestration')).toBe('low'); // view/pause/resume an existing run
    expect(riskOfShape('schedule')).toBe('medium'); // AO8-4 — reversible but commits future runs
    expect(riskOfShape('mission')).toBe('high'); // M6 — autonomous multi-capability run
    expect(riskOfShape('scope')).toBe('low'); // AO9-3 — read-only understand-first
    expect(riskOfShape('preview')).toBe('low'); // RUN-FIX-26 — read + serve locally, reversible
  });
});

describe('schedule extraction (AO8-4, NL → cadence + task, LLM, multi-language)', () => {
  it('parses a {cadence, task} JSON object; null when a field is missing', () => {
    expect(parseScheduleExtraction('{"cadence":"every 2h","task":"run the test sweep"}')).toEqual({
      cadence: 'every 2h',
      task: 'run the test sweep',
    });
    // fence/prose tolerant via firstJsonObject
    expect(
      parseScheduleExtraction('Sure:\n```json\n{"cadence":"at 09:00","task":"publish"}\n```'),
    ).toEqual({ cadence: 'at 09:00', task: 'publish' });
    expect(parseScheduleExtraction('{"cadence":"","task":"x"}')).toBeNull();
    expect(parseScheduleExtraction('{"task":"x"}')).toBeNull();
    expect(parseScheduleExtraction('no json here')).toBeNull();
    // AO8-4 review #16 — a TRUNCATED object (the exact shape a too-small token cap
    // produces, e.g. the 6-token intent adapter) has no closing brace → null, NOT a
    // partial parse. This is the failure mode that made NL scheduling silently no-op.
    expect(parseScheduleExtraction('{"cadence":"at 0')).toBeNull();
    expect(parseScheduleExtraction('{"cadence":"every 2h","task":"run the te')).toBeNull();
  });

  it('builds a language-agnostic prompt that carries the request verbatim', () => {
    const p = buildScheduleExtractionPrompt('cada 2 horas haz el barrido de tests');
    expect(p).toContain('cada 2 horas haz el barrido de tests');
    expect(p).toContain('cadence');
    expect(p).toContain('task');
  });

  it('classifies via the injected model regardless of language; null on error', async () => {
    const model = vi
      .fn()
      .mockResolvedValue('{"cadence":"at 09:00","task":"haz el barrido de tests"}');
    expect(await classifyScheduleExtraction('cada mañana haz el barrido de tests', model)).toEqual({
      cadence: 'at 09:00',
      task: 'haz el barrido de tests',
    });
    expect(model.mock.calls[0]?.[0]).toContain('cada mañana haz el barrido de tests');
    const boom = vi.fn().mockRejectedValue(new Error('down'));
    expect(await classifyScheduleExtraction('every morning run X', boom)).toBeNull();
  });
});

describe('orchestration control action (AO6 Pillar 5, LLM, multi-language)', () => {
  it('parses the action word; unknown → show (the safe read)', () => {
    expect(parseOrchestrationAction('pause')).toBe('pause');
    expect(parseOrchestrationAction('  RESUME it\n')).toBe('resume');
    expect(parseOrchestrationAction('open the chronogram')).toBe('show');
    expect(parseOrchestrationAction('no idea')).toBe('show');
  });

  it('classifies via the injected model regardless of language; defaults to show on error', async () => {
    const pause = vi.fn().mockResolvedValue('pause');
    expect(await classifyOrchestrationAction('pausa la orquestación', pause)).toBe('pause');
    expect(pause.mock.calls[0]?.[0]).toContain('pausa la orquestación');
    const boom = vi.fn().mockRejectedValue(new Error('down'));
    expect(await classifyOrchestrationAction('montre le chronogramme', boom)).toBe('show');
  });
});

describe('decidePosture (AO3d-2, proactive 3-way, pure)', () => {
  it('low confidence always asks (never silently guesses a heavy route)', () => {
    expect(decidePosture({ risk: 'low', confidence: 'low', level: 4, autoApprove: true })).toBe(
      'ask',
    );
  });
  it('acts on low/medium-risk shapes at high autonomy without a flag', () => {
    expect(decidePosture({ risk: 'low', confidence: 'high', level: 3, autoApprove: false })).toBe(
      'act',
    );
    expect(
      decidePosture({ risk: 'medium', confidence: 'high', level: 3, autoApprove: false }),
    ).toBe('act');
  });
  it('asks for a medium-risk shape at a low autonomy level', () => {
    expect(
      decidePosture({ risk: 'medium', confidence: 'high', level: 2, autoApprove: false }),
    ).toBe('ask');
  });
  it('high-risk narrates-while-acting at FULL autonomy (L4) or with auto-approve; asks below L4 (ORCH1)', () => {
    // ORCH1: at L4 the expensive multi-agent routes (explore/mission/goal) act-with-narration
    // even without an explicit auto-approve — the safety floors still bind.
    expect(decidePosture({ risk: 'high', confidence: 'high', level: 4, autoApprove: false })).toBe(
      'narrate',
    );
    expect(decidePosture({ risk: 'high', confidence: 'high', level: 4, autoApprove: true })).toBe(
      'narrate',
    );
    // Below L4 without auto-approve, a high-risk route still asks.
    expect(decidePosture({ risk: 'high', confidence: 'high', level: 3, autoApprove: false })).toBe(
      'ask',
    );
    // A low-confidence classification NEVER silently runs a heavy route, even at L4.
    expect(decidePosture({ risk: 'high', confidence: 'low', level: 4, autoApprove: true })).toBe(
      'ask',
    );
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

  it('treats a bare `exit` / `quit` as the exit command (universal terminal convention)', () => {
    for (const word of ['exit', 'quit', 'EXIT', 'Quit', '  exit  ']) {
      expect(parseStructuralInput(word)).toEqual({
        kind: 'command',
        name: word.trim().toLowerCase(),
        argv: [],
      });
    }
    // But only as the WHOLE line — "exit the loop in foo.ts" is still a real task.
    expect(parseStructuralInput('exit the loop early in foo.ts').kind).toBe('natural');
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
