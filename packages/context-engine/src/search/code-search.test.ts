import { afterEach, describe, expect, it } from 'vitest';
import { makeFixtureDir, removeFixtureDir } from '../test-utils';
import { searchRepoCode, tokenizeQuery } from './code-search';

/** A small but realistic fixture repo with auth, billing, tests and secrets. */
async function fixtureRepo(): Promise<string> {
  return makeFixtureDir({
    'src/auth/login.ts': [
      "import { createSession } from './session';",
      '',
      'export interface LoginRequest {',
      '  username: string;',
      '  password: string;',
      '}',
      '',
      'export async function login(request: LoginRequest): Promise<string> {',
      '  // authenticate the user and start a session',
      '  const session = await createSession(request.username);',
      '  return session.token;',
      '}',
      '',
    ].join('\n'),
    'src/auth/session.ts': [
      'export interface Session {',
      '  token: string;',
      '  username: string;',
      '}',
      '',
      'export async function createSession(username: string): Promise<Session> {',
      "  return { token: 'tok_' + username, username };",
      '}',
      '',
    ].join('\n'),
    'src/billing/invoice.ts': [
      'export interface Invoice {',
      '  id: string;',
      '  amountCents: number;',
      '}',
      '',
      'export function createInvoice(id: string, amountCents: number): Invoice {',
      '  return { id, amountCents };',
      '}',
      '',
    ].join('\n'),
    'tests/login.test.ts': [
      "import { login } from '../src/auth/login';",
      '',
      "it('logs in', async () => {",
      "  const token = await login({ username: 'a', password: 'b' });",
      '  expect(token).toBeDefined();',
      '});',
      '',
    ].join('\n'),
    '.env': 'SECRET_API_KEY=AKIAIOSFODNN7EXAMPLE\nDB_PASSWORD=hunter2\n',
    'src/secrets/keys.ts': 'export const SIGNING_KEY = "do-not-leak-login-session";\n',
    'node_modules/leftpad/index.js': 'module.exports = function login() { return "session"; };\n',
    'dist/bundle.js': 'function login(){return "session"}\n',
  });
}

describe('tokenizeQuery', () => {
  it('splits camelCase / snake / kebab, lowercases, drops stopwords and short terms', () => {
    const terms = tokenizeQuery('How does the createSession function work?');
    // camelCase split: createSession → create + session. Stopwords (how/the)
    // and short terms (<3) dropped; the set is sorted + de-duplicated.
    expect(terms).toContain('create');
    expect(terms).toContain('session');
    expect(terms).toContain('function');
    expect(terms).toContain('work');
    expect(terms).not.toContain('how');
    expect(terms).not.toContain('the');
    expect([...terms]).toEqual([...terms].sort());
  });

  it('keeps whitelisted short terms (db/id/ui) and stems plurals', () => {
    const terms = tokenizeQuery('database id sessions');
    expect(terms).toContain('id');
    expect(terms).toContain('session'); // sessions → session
  });

  it('returns a sorted, de-duplicated set', () => {
    const terms = tokenizeQuery('login Login LOGIN');
    expect(terms).toEqual(['login']);
  });
});

describe('searchRepoCode', () => {
  let repos: string[] = [];
  afterEach(async () => {
    await Promise.all(repos.map(removeFixtureDir));
    repos = [];
  });
  async function repo(): Promise<string> {
    const dir = await fixtureRepo();
    repos.push(dir);
    return dir;
  }

  it('ranks auth files above billing for an auth query', async () => {
    const result = await searchRepoCode(await repo(), { query: 'login session token' });
    expect(result.hits.length).toBeGreaterThan(0);
    const paths = result.hits.map((hit) => hit.path);
    const authIndex = paths.findIndex((p) => p.startsWith('src/auth/'));
    const billingIndex = paths.findIndex((p) => p.startsWith('src/billing/'));
    expect(authIndex).toBeGreaterThanOrEqual(0);
    if (billingIndex >= 0) {
      expect(authIndex).toBeLessThan(billingIndex);
    }
  });

  it('never surfaces node_modules, dist, .env or secret files', async () => {
    const result = await searchRepoCode(await repo(), { query: 'login session key' });
    const paths = result.hits.map((hit) => hit.path);
    for (const path of paths) {
      expect(path.startsWith('node_modules/')).toBe(false);
      expect(path.startsWith('dist/')).toBe(false);
      expect(path.startsWith('src/secrets/')).toBe(false);
      expect(path.endsWith('.env')).toBe(false);
    }
    // The secret value never appears in any snippet either.
    const allText = result.hits.flatMap((h) => h.snippets.map((s) => s.text)).join('\n');
    expect(allText).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(allText).not.toContain('do-not-leak');
  });

  it('returns 1-based snippet line ranges that match the source', async () => {
    const dir = await repo();
    const result = await searchRepoCode(dir, { query: 'createSession session' });
    const sessionHit = result.hits.find((hit) => hit.path === 'src/auth/session.ts');
    expect(sessionHit).toBeDefined();
    const snippet = sessionHit?.snippets[0];
    expect(snippet).toBeDefined();
    expect(snippet?.startLine).toBeGreaterThanOrEqual(1);
    expect(snippet?.endLine).toBeGreaterThanOrEqual(snippet?.startLine ?? 1);
    // The declaration line really is within the reported window.
    expect(snippet?.text).toContain('createSession');
  });

  it('is byte-identical across repeated runs (determinism)', async () => {
    const dir = await repo();
    const a = await searchRepoCode(dir, { query: 'login session token' });
    const b = await searchRepoCode(dir, { query: 'login session token' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('truncates by maxFiles and flags stats.truncated', async () => {
    const result = await searchRepoCode(await repo(), {
      query: 'login session token',
      maxFiles: 1,
    });
    expect(result.hits.length).toBeLessThanOrEqual(1);
    expect(result.stats.truncated).toBe(true);
  });

  it('truncates by totalCharBudget and flags stats.truncated', async () => {
    const result = await searchRepoCode(await repo(), {
      query: 'login session token',
      totalCharBudget: 40,
    });
    const totalChars = result.hits
      .flatMap((hit) => hit.snippets.map((s) => s.text.length))
      .reduce((sum, n) => sum + n, 0);
    expect(totalChars).toBeLessThanOrEqual(60); // budget + a marker
    expect(result.stats.truncated).toBe(true);
  });

  it('boosts same-directory and imported neighbors via anchorPath', async () => {
    const dir = await repo();
    // Anchor on login.ts: session.ts is same-dir AND imported; invoice.ts is neither.
    const result = await searchRepoCode(dir, {
      query: 'invoice session',
      anchorPath: 'src/auth/login.ts',
    });
    const paths = result.hits.map((hit) => hit.path);
    const sessionIdx = paths.indexOf('src/auth/session.ts');
    const invoiceIdx = paths.indexOf('src/billing/invoice.ts');
    expect(sessionIdx).toBeGreaterThanOrEqual(0);
    if (invoiceIdx >= 0) {
      expect(sessionIdx).toBeLessThan(invoiceIdx);
    }
    // The anchor file itself is never returned as a hit.
    expect(paths).not.toContain('src/auth/login.ts');
    const sessionHit = result.hits.find((hit) => hit.path === 'src/auth/session.ts');
    expect(sessionHit?.reasons.join(' ')).toMatch(/same directory|imported by anchor/);
  });

  it('breaks score ties by POSIX path ascending', async () => {
    // Two files with identical content + name length → identical score.
    const dir = await makeFixtureDir({
      'src/b_widget.ts': 'export function render() { return "widget"; }\n',
      'src/a_widget.ts': 'export function render() { return "widget"; }\n',
    });
    repos.push(dir);
    const result = await searchRepoCode(dir, { query: 'widget render' });
    const paths = result.hits.map((hit) => hit.path);
    expect(paths.indexOf('src/a_widget.ts')).toBeLessThan(paths.indexOf('src/b_widget.ts'));
  });

  it('returns an empty result for a query with no usable terms', async () => {
    const result = await searchRepoCode(await repo(), { query: 'the a an of' });
    expect(result.terms).toEqual([]);
    expect(result.hits).toEqual([]);
  });

  it('normalizes the top score to 1', async () => {
    const result = await searchRepoCode(await repo(), { query: 'login session' });
    expect(result.hits[0]?.score).toBeCloseTo(1, 6);
  });
});
