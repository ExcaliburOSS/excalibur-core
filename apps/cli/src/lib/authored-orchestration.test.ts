import { describe, expect, it } from 'vitest';
import { SWARM_MAX_TOTAL_AGENTS } from '@excalibur/core';
import { compileAuthoredOrchestration, resolveAuthoredSpecPath } from './authored-orchestration';
import { CliUsageError } from '../errors';

describe('compileAuthoredOrchestration (AO5-4)', () => {
  it('compiles named steps into SwarmSubtask[] (ids preserved, deps + role threaded)', () => {
    const { task, subtasks } = compileAuthoredOrchestration({
      task: 'build the thing',
      steps: [
        { id: 'base', instruction: 'create the base module' },
        { id: 'api', instruction: 'add the api', dependsOn: ['base'] },
        { id: 'review', instruction: 'review it', dependsOn: ['api'], role: 'reviewer' },
      ],
    });
    expect(task).toBe('build the thing');
    expect(subtasks.map((s) => s.id)).toEqual(['base', 'api', 'review']);
    expect(subtasks[1]?.dependsOn).toEqual(['base']);
    expect(subtasks[2]?.role).toBe('reviewer');
    // Title defaults to the instruction (truncated) when omitted.
    expect(subtasks[0]?.title).toBe('create the base module');
  });

  it('defaults the task to the joined step titles when absent', () => {
    const { task } = compileAuthoredOrchestration({
      steps: [
        { id: 'a', instruction: 'do a', title: 'Step A' },
        { id: 'b', instruction: 'do b', title: 'Step B' },
      ],
    });
    expect(task).toBe('Step A; Step B');
  });

  const bad =
    (raw: unknown): (() => void) =>
    () =>
      compileAuthoredOrchestration(raw);

  it('rejects an empty / missing steps list', () => {
    expect(bad({})).toThrow(CliUsageError);
    expect(bad({ steps: [] })).toThrow(CliUsageError);
    expect(bad('nope')).toThrow(CliUsageError);
  });

  it('rejects an over-large spec at the boundary (cap compiles, cap+1 throws)', () => {
    const mkSteps = (n: number) =>
      Array.from({ length: n }, (_v, i) => ({ id: `s${i}`, instruction: 'x' }));
    // Exactly the cap compiles; one more is a fail-fast error (no silent truncation).
    expect(() =>
      compileAuthoredOrchestration({ steps: mkSteps(SWARM_MAX_TOTAL_AGENTS) }),
    ).not.toThrow();
    expect(bad({ steps: mkSteps(SWARM_MAX_TOTAL_AGENTS + 1) })).toThrow(/too many steps/);
  });

  it('rejects a non-list dependsOn (a bare scalar would silently mis-schedule)', () => {
    expect(
      bad({
        steps: [
          { id: 'a', instruction: 'x' },
          { id: 'b', instruction: 'y', dependsOn: 'a' },
        ],
      }),
    ).toThrow(/non-list "dependsOn"/);
  });

  it('rejects a present-but-non-string id with a clear message (not "missing")', () => {
    expect(bad({ steps: [{ id: 123, instruction: 'x' }] })).toThrow(/id must be a string/);
  });

  it('rejects a missing/empty/duplicate/unsafe id', () => {
    expect(bad({ steps: [{ instruction: 'x' }] })).toThrow(/missing an "id"/);
    expect(bad({ steps: [{ id: 'a b', instruction: 'x' }] })).toThrow(/invalid id/);
    expect(bad({ steps: [{ id: 'a/b', instruction: 'x' }] })).toThrow(/invalid id/);
    expect(
      bad({
        steps: [
          { id: 'a', instruction: 'x' },
          { id: 'a', instruction: 'y' },
        ],
      }),
    ).toThrow(/duplicate step id/);
  });

  it('rejects a missing instruction', () => {
    expect(bad({ steps: [{ id: 'a' }] })).toThrow(/missing an "instruction"/);
  });

  it('rejects an unknown or self dependsOn (an author typo is an ERROR, not ignored)', () => {
    expect(bad({ steps: [{ id: 'a', instruction: 'x', dependsOn: ['nope'] }] })).toThrow(
      /unknown step "nope"/,
    );
    expect(bad({ steps: [{ id: 'a', instruction: 'x', dependsOn: ['a'] }] })).toThrow(
      /depends on itself/,
    );
  });

  it('HARD-rejects a dependency cycle (the auto path silently flattens)', () => {
    expect(
      bad({
        steps: [
          { id: 'a', instruction: 'x', dependsOn: ['b'] },
          { id: 'b', instruction: 'y', dependsOn: ['a'] },
        ],
      }),
    ).toThrow(/CYCLE/);
  });

  it('rejects an invalid role', () => {
    expect(bad({ steps: [{ id: 'a', instruction: 'x', role: 'wizard' }] })).toThrow(/invalid role/);
  });

  it('AO7-2: threads maxAttempts + when, and rejects invalid values', () => {
    const { subtasks } = compileAuthoredOrchestration({
      steps: [
        { id: 'a', instruction: 'build' },
        { id: 'b', instruction: 'rescue', dependsOn: ['a'], when: 'on_failure', maxAttempts: 3 },
      ],
    });
    expect(subtasks[1]).toMatchObject({ when: 'on_failure', maxAttempts: 3 });
    expect(bad({ steps: [{ id: 'a', instruction: 'x', maxAttempts: 0 }] })).toThrow(
      /maxAttempts must be a positive integer/,
    );
    expect(bad({ steps: [{ id: 'a', instruction: 'x', maxAttempts: 1.5 }] })).toThrow(
      /maxAttempts must be a positive integer/,
    );
    expect(bad({ steps: [{ id: 'a', instruction: 'x', when: 'sometimes' }] })).toThrow(
      /invalid "when"/,
    );
  });

  it('AO7-4: threads an outputSchema onto the subtask, and rejects a non-mapping one', () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    const { subtasks } = compileAuthoredOrchestration({
      steps: [{ id: 'a', instruction: 'analyze', outputSchema: schema }],
    });
    expect(subtasks[0]?.outputSchema).toEqual(schema);
    expect(bad({ steps: [{ id: 'a', instruction: 'x', outputSchema: 'nope' }] })).toThrow(
      /non-mapping "outputSchema"/,
    );
  });
});

describe('resolveAuthoredSpecPath', () => {
  it('maps a bare name to the .excalibur/orchestrations convention', () => {
    expect(resolveAuthoredSpecPath('/repo', 'ship')).toBe(
      '/repo/.excalibur/orchestrations/ship.yaml',
    );
  });
  it('treats a path-like arg as a file path (resolved against the repo)', () => {
    expect(resolveAuthoredSpecPath('/repo', 'plans/ship.yaml')).toBe('/repo/plans/ship.yaml');
    expect(resolveAuthoredSpecPath('/repo', '/abs/ship.yml')).toBe('/abs/ship.yml');
  });
});
