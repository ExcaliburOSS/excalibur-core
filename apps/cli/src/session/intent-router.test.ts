import { describe, expect, it } from 'vitest';
import { classifyTurnIntent, type IntentContext } from './intent-router';

const live: IntentContext = { interactive: true, mock: false, level: 4 };

describe('classifyTurnIntent', () => {
  it('routes a multi-step build request to plan', () => {
    expect(classifyTurnIntent('implement a rate limiter for the API', live)).toBe('plan');
    expect(classifyTurnIntent('refactor the auth module', live)).toBe('plan');
    expect(classifyTurnIntent('añade un endpoint para usuarios', live)).toBe('plan');
  });

  it('routes a parallelizable request to swarm', () => {
    expect(classifyTurnIntent('add tests for each of these modules', live)).toBe('swarm');
    expect(classifyTurnIntent('migra todos los servicios en paralelo', live)).toBe('swarm');
  });

  it('routes a long-running request to bg', () => {
    expect(classifyTurnIntent('run the full migration in the background', live)).toBe('bg');
    expect(classifyTurnIntent('haz esto en segundo plano', live)).toBe('bg');
  });

  it('keeps questions and plain lines as a direct chat turn', () => {
    expect(classifyTurnIntent('how does the run pipeline work?', live)).toBe('chat');
    expect(classifyTurnIntent('what files changed?', live)).toBe('chat');
    expect(classifyTurnIntent('¿cómo implemento el parser?', live)).toBe('chat'); // a question, even with "implemento"
    expect(classifyTurnIntent('show me the diff', live)).toBe('chat');
  });

  it('never routes without a real model, off a TTY, or at a read-only level', () => {
    const build = 'implement a rate limiter';
    expect(classifyTurnIntent(build, { ...live, mock: true })).toBe('chat');
    expect(classifyTurnIntent(build, { ...live, interactive: false })).toBe('chat');
    expect(classifyTurnIntent(build, { ...live, level: 1 })).toBe('chat');
  });
});
