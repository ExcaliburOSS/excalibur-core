import { describe, expect, it } from 'vitest';
import { classifyError, friendlyError, lastErrorDetail, reportFriendly } from './friendly-error';
import { createInteractiveCli } from '../test-utils';

describe('classifyError — the error taxonomy', () => {
  const cases: [unknown, string][] = [
    [Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 'network'],
    [Object.assign(new Error('getaddrinfo ENOTFOUND api'), { code: 'ENOTFOUND' }), 'network'],
    [Object.assign(new Error('Unauthorized'), { status: 401 }), 'auth'],
    [new Error('invalid api key'), 'auth'],
    [Object.assign(new Error('Too Many Requests'), { status: 429 }), 'rate_limit'],
    [Object.assign(new Error('permission denied'), { code: 'EACCES' }), 'permission'],
    [Object.assign(new Error('no such file'), { code: 'ENOENT' }), 'not_found'],
    [new Error('the request timed out'), 'timeout'],
    [new Error('fatal: not a git repository'), 'git'],
    [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'cancelled'],
    [new Error('something weird happened'), 'unknown'],
  ];
  it.each(cases)('classifies %o as %s', (error, expected) => {
    expect(classifyError(error)).toBe(expected);
  });
});

describe('friendlyError — warm, actionable, no raw dump', () => {
  it('gives a warm headline + actionable hint, keeps raw detail separate', () => {
    const f = friendlyError(
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
      { doing: 'reaching the model' },
    );
    expect(f.code).toBe('network');
    expect(f.headline).toContain('network');
    expect(f.headline).not.toContain('ECONNREFUSED'); // no raw code in the headline
    expect(f.hint).toBeDefined();
    expect(f.detail).toContain('ECONNREFUSED'); // raw detail preserved for /why
  });

  it('an unknown error is reassuring, not a stack dump', () => {
    const f = friendlyError(new Error('TypeError: cannot read x of undefined'));
    expect(f.headline.toLowerCase()).toContain('something went wrong');
    expect(f.headline).not.toContain('TypeError');
  });
});

describe('reportFriendly — renders warm + stashes detail for /why', () => {
  it('prints the headline (not the raw message) and remembers the detail', () => {
    const cli = createInteractiveCli({ cwd: '/tmp' });
    reportFriendly(cli.deps, new Error('ECONNREFUSED boom'), { doing: 'running that' });
    const out = cli.stdout();
    expect(out).not.toContain('ECONNREFUSED'); // raw never dumped by default
    expect(lastErrorDetail()?.detail).toContain('ECONNREFUSED'); // but available to /why
  });
});
