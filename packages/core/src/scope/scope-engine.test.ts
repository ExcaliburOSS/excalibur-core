import { describe, expect, it, vi } from 'vitest';
import {
  buildScopeAnglesPrompt,
  buildScopeExplorePrompt,
  parseScopeAngles,
  parseScopeFragment,
  parseScopeMap,
  scopeAngleCount,
  scopeMapToMarkdown,
  scopeTask,
  SCOPE_FRAGMENT_SCHEMA,
  type ScopeFragment,
} from './scope-engine';

describe('scopeAngleCount (AO9-1 — read-only auto-dimensioning, pure)', () => {
  it('scales with complexity and is hard-capped', () => {
    expect(scopeAngleCount({ complexity: 'small' })).toBe(2);
    expect(scopeAngleCount({ complexity: 'medium' })).toBe(4);
    expect(scopeAngleCount({ complexity: 'large' })).toBe(6);
    expect(scopeAngleCount({ complexity: 'large', hardCap: 3 })).toBe(3); // never exceeds the cap
    expect(scopeAngleCount({ complexity: 'small', hardCap: 0 })).toBe(1); // never below 1
  });
});

describe('parseScopeAngles (pure)', () => {
  it('parses {angles:[...]}, assigns ids, drops empty entries', () => {
    const out = parseScopeAngles(
      '{"angles":[{"subsystem":"auth","question":"where is login?"},{"subsystem":"","question":""},{"subsystem":"db"}]}',
    );
    expect(out).toEqual([
      { id: 'angle_1', subsystem: 'auth', question: 'where is login?' },
      { id: 'angle_2', subsystem: 'db', question: 'db' }, // question falls back to subsystem
    ]);
  });
  it('returns [] on non-JSON or a missing angles array', () => {
    expect(parseScopeAngles('no json')).toEqual([]);
    expect(parseScopeAngles('{"foo":1}')).toEqual([]);
  });
});

describe('parseScopeFragment (pure, schema-validated)', () => {
  it('parses a well-formed fragment', () => {
    const f = parseScopeFragment(
      '{"subsystem":"auth","files":["src/auth.ts:12"],"whatExists":"oauth","whatsMissing":"mfa","risks":["token leak"]}',
      'auth',
    );
    expect(f).toEqual({
      subsystem: 'auth',
      files: ['src/auth.ts:12'],
      whatExists: 'oauth',
      whatsMissing: 'mfa',
      risks: ['token leak'],
    });
  });
  it('coerces a close-but-loose object and drops a truly empty one', () => {
    // missing `files`/`risks` → coerced to [] (the value still carries findings)
    const f = parseScopeFragment(
      '{"subsystem":"db","whatExists":"postgres","whatsMissing":""}',
      'db',
    );
    expect(f).toMatchObject({ subsystem: 'db', whatExists: 'postgres', files: [], risks: [] });
    // nothing useful → null
    expect(parseScopeFragment('{"subsystem":"x"}', 'x')).toBeNull();
    expect(parseScopeFragment('not json', 'x')).toBeNull();
  });
});

describe('prompts (pure, language-agnostic)', () => {
  it('the explore prompt carries the angle + the schema instruction', () => {
    const p = buildScopeExplorePrompt('add MFA', {
      id: 'a1',
      subsystem: 'auth',
      question: 'how is login done?',
    });
    expect(p).toContain('add MFA');
    expect(p).toContain('auth');
    expect(p).toContain('how is login done?');
    expect(p).toContain('READ-ONLY');
    expect(p).toContain('whatsMissing'); // the schema instruction names the fields
  });
  it('the angles prompt bounds the count and carries the task verbatim', () => {
    const p = buildScopeAnglesPrompt('migrar a GraphQL', 5);
    expect(p).toContain('migrar a GraphQL');
    expect(p).toContain('up to 5');
  });
});

describe('parseScopeMap (pure)', () => {
  it('merges synthesis output with the fragments', () => {
    const frags: ScopeFragment[] = [
      { subsystem: 'auth', files: ['a.ts'], whatExists: 'x', whatsMissing: 'y', risks: [] },
    ];
    const map = parseScopeMap(
      '{"summary":"two areas","risks":["r1"],"openQuestions":["q1"]}',
      'add MFA',
      frags,
    );
    expect(map).toEqual({
      task: 'add MFA',
      summary: 'two areas',
      subsystems: frags,
      risks: ['r1'],
      openQuestions: ['q1'],
    });
  });
});

describe('scopeTask (AO9-1 orchestration, injected model + explorer)', () => {
  const frag = (subsystem: string): ScopeFragment => ({
    subsystem,
    files: [`${subsystem}.ts`],
    whatExists: `${subsystem} exists`,
    whatsMissing: `${subsystem} gap`,
    risks: [],
  });

  it('decomposes → fans out explorers → synthesizes a ScopeMap', async () => {
    const classify = vi
      .fn()
      // 1st call = decompose, 2nd = synthesize
      .mockResolvedValueOnce(
        '{"angles":[{"subsystem":"auth","question":"?"},{"subsystem":"db","question":"?"}]}',
      )
      .mockResolvedValueOnce(
        '{"summary":"auth + db","risks":["migration"],"openQuestions":["which provider?"]}',
      );
    const explore = vi.fn(async (_task, angle) => frag(angle.subsystem));

    const map = await scopeTask('add MFA', { classify, explore, complexity: 'small' });
    expect(map).not.toBeNull();
    expect(map!.summary).toBe('auth + db');
    expect(map!.subsystems.map((s) => s.subsystem)).toEqual(['auth', 'db']);
    expect(map!.risks).toEqual(['migration']);
    expect(explore).toHaveBeenCalledTimes(2); // one per angle, in parallel
    expect(classify).toHaveBeenCalledTimes(2); // decompose + synthesize
  });

  it('returns null on an empty task (no model call)', async () => {
    const classify = vi.fn();
    expect(await scopeTask('   ', { classify, explore: vi.fn() })).toBeNull();
    expect(classify).not.toHaveBeenCalled();
  });

  it('returns null when decompose yields no angles', async () => {
    const classify = vi.fn().mockResolvedValue('{"angles":[]}');
    expect(await scopeTask('x', { classify, explore: vi.fn() })).toBeNull();
  });

  it('drops a failing explorer but still ships a partial map', async () => {
    const classify = vi
      .fn()
      .mockResolvedValueOnce('{"angles":[{"subsystem":"auth"},{"subsystem":"db"}]}')
      .mockResolvedValueOnce('{"summary":"partial"}');
    const explore = vi
      .fn()
      .mockImplementationOnce(async () => frag('auth'))
      .mockImplementationOnce(async () => {
        throw new Error('explorer crashed');
      });
    const map = await scopeTask('x', { classify, explore });
    expect(map!.subsystems.map((s) => s.subsystem)).toEqual(['auth']); // db dropped
  });

  it('returns null when EVERY explorer fails', async () => {
    const classify = vi.fn().mockResolvedValue('{"angles":[{"subsystem":"auth"}]}');
    const explore = vi.fn().mockResolvedValue(null);
    expect(await scopeTask('x', { classify, explore })).toBeNull();
  });

  it('falls back to a minimal map when synthesis throws', async () => {
    const classify = vi
      .fn()
      .mockResolvedValueOnce('{"angles":[{"subsystem":"auth"}]}')
      .mockRejectedValueOnce(new Error('synth down'));
    const explore = vi.fn(async () => frag('auth'));
    const map = await scopeTask('x', { classify, explore });
    expect(map).toMatchObject({ task: 'x', summary: '', subsystems: [frag('auth')] });
  });

  it('honours maxAngles (caps the fan-out)', async () => {
    const classify = vi
      .fn()
      .mockResolvedValueOnce(
        '{"angles":[{"subsystem":"a"},{"subsystem":"b"},{"subsystem":"c"},{"subsystem":"d"}]}',
      )
      .mockResolvedValueOnce('{"summary":"ok"}');
    const explore = vi.fn(async (_t, angle) => frag(angle.subsystem));
    await scopeTask('x', { classify, explore, maxAngles: 2 });
    expect(explore).toHaveBeenCalledTimes(2); // capped to 2 even though 4 were proposed
  });
});

describe('scopeMapToMarkdown (pure render)', () => {
  it('renders subsystems, files, exists/missing, risks and open questions', () => {
    const md = scopeMapToMarkdown({
      task: 'add MFA',
      summary: 'two areas',
      subsystems: [
        {
          subsystem: 'auth',
          files: ['a.ts'],
          whatExists: 'oauth',
          whatsMissing: 'mfa',
          risks: ['leak'],
        },
      ],
      risks: ['migration'],
      openQuestions: ['which provider?'],
    });
    expect(md).toContain('# Scope — add MFA');
    expect(md).toContain('## auth');
    expect(md).toContain('Files: a.ts');
    expect(md).toContain('Missing: mfa');
    expect(md).toContain('⚠ leak');
    expect(md).toContain('which provider?');
  });
});

describe('SCOPE_FRAGMENT_SCHEMA', () => {
  it('requires the five fragment fields', () => {
    expect(SCOPE_FRAGMENT_SCHEMA.required).toEqual([
      'subsystem',
      'files',
      'whatExists',
      'whatsMissing',
      'risks',
    ]);
  });
});
