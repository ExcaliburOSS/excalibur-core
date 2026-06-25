import { describe, expect, it, vi } from 'vitest';
import {
  buildScopeAnglesPrompt,
  buildScopeExplorePrompt,
  mergeFragmentsBySubsystem,
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
  it('drops a SCHEMA-VALID but findings-empty fragment (strict & loose paths agree)', () => {
    // A reasoning model can return a schema-conforming object with empty strings;
    // it must be dropped exactly like the loose equivalent (the review HIGH/MED fix).
    expect(
      parseScopeFragment(
        '{"subsystem":"auth","files":[],"whatExists":"","whatsMissing":"","risks":[]}',
        'auth',
      ),
    ).toBeNull();
    // whitespace-only prose is still empty
    expect(
      parseScopeFragment(
        '{"subsystem":"auth","files":["a.ts"],"whatExists":"  ","whatsMissing":"\\n","risks":["r"]}',
        'auth',
      ),
    ).toBeNull();
  });
});

describe('mergeFragmentsBySubsystem (pure dedup/merge)', () => {
  it('merges same-subsystem fragments: unions files/risks, joins distinct prose', () => {
    const merged = mergeFragmentsBySubsystem([
      {
        subsystem: 'auth',
        files: ['a.ts'],
        whatExists: 'oauth',
        whatsMissing: 'mfa',
        risks: ['r1'],
      },
      {
        subsystem: 'Auth',
        files: ['a.ts', 'b.ts'],
        whatExists: 'oauth',
        whatsMissing: 'totp',
        risks: ['r2'],
      },
      { subsystem: 'db', files: ['db.ts'], whatExists: 'pg', whatsMissing: 'col', risks: [] },
    ]);
    expect(merged).toHaveLength(2); // auth + Auth collapsed (case-insensitive), db separate
    const auth = merged[0]!;
    expect(auth.subsystem).toBe('auth'); // first casing wins
    expect(auth.files).toEqual(['a.ts', 'b.ts']); // unioned, deduped, order-preserving
    expect(auth.risks).toEqual(['r1', 'r2']);
    expect(auth.whatExists).toBe('oauth'); // identical prose not duplicated
    expect(auth.whatsMissing).toBe('mfa\n\ntotp'); // distinct prose joined
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

  it('emits decompose → explore×N → synthesize progress (a throwing sink is non-fatal)', async () => {
    const classify = vi
      .fn()
      .mockResolvedValueOnce('{"angles":[{"subsystem":"auth"},{"subsystem":"db"}]}')
      .mockResolvedValueOnce('{"summary":"ok"}');
    const explore = vi.fn(async (_t, angle) => frag(angle.subsystem));
    const phases: string[] = [];
    const map = await scopeTask('x', {
      classify,
      explore,
      onProgress: (p) => {
        phases.push(p.phase);
        throw new Error('sink blew up'); // must NOT break the flow
      },
    });
    expect(map).not.toBeNull(); // a throwing sink did not abort scoping
    expect(phases[0]).toBe('decompose');
    expect(phases.filter((p) => p === 'explore')).toHaveLength(2); // one per angle
    expect(phases[phases.length - 1]).toBe('synthesize');
  });

  it('merges explorers that landed on the same subsystem (deduped/merged contract)', async () => {
    const classify = vi
      .fn()
      .mockResolvedValueOnce('{"angles":[{"subsystem":"auth"},{"subsystem":"Auth"}]}')
      .mockResolvedValueOnce('{"summary":"ok"}');
    const explore = vi.fn(async (_t, angle) => frag(angle.subsystem));
    const map = await scopeTask('x', { classify, explore });
    expect(map!.subsystems).toHaveLength(1); // two 'auth' angles → one merged section
  });

  it('returns null when every explorer returns a schema-valid but empty fragment', async () => {
    // The strict-path empty drop must hold the all-fail→null invariant end to end.
    const classify = vi.fn().mockResolvedValue('{"angles":[{"subsystem":"auth"}]}');
    const explore = vi.fn(async () =>
      parseScopeFragment(
        '{"subsystem":"auth","files":[],"whatExists":"","whatsMissing":"","risks":[]}',
        'auth',
      ),
    );
    expect(await scopeTask('x', { classify, explore })).toBeNull();
  });

  it('clamps an injected maxAngles to ANGLE_HARD_CAP (no fan-out bomb)', async () => {
    const angles = Array.from({ length: 12 }, (_, i) => ({ subsystem: `s${i}` }));
    const classify = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ angles }))
      .mockResolvedValueOnce('{"summary":"ok"}');
    const explore = vi.fn(async (_t, angle) => frag(angle.subsystem));
    await scopeTask('x', { classify, explore, maxAngles: 999 }); // injected, bypasses CLI 1-8
    expect(explore.mock.calls.length).toBeLessThanOrEqual(8); // hard cap honoured
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
