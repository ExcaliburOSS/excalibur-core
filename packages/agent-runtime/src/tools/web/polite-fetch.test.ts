import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebCache } from './cache';
import type { FetchImpl } from './fetch';
import {
  RateLimiter,
  RobotsDisallowedError,
  parseRobots,
  politeFetch,
  robotsAllows,
} from './polite-fetch';

// Public-IP host → the SSRF guard short-circuits with NO real DNS (offline).
const PUBLIC = 'http://93.184.216.34/';
const HTML =
  '<!doctype html><html><head><title>Doc</title></head><body><article><p>real body text here that survives</p></article></body></html>';

/** A fetchImpl that serves robots.txt and HTML pages from a map. */
function fakeFetch(robots: string, opts: { onPage?: () => void } = {}): FetchImpl {
  return async (url) => {
    if (url.endsWith('/robots.txt')) {
      return new Response(robots, { headers: { 'content-type': 'text/plain' } });
    }
    opts.onPage?.();
    return new Response(HTML, { headers: { 'content-type': 'text/html' } });
  };
}

describe('parseRobots / robotsAllows', () => {
  it('honors a wildcard Disallow with an Allow override', () => {
    const rules = parseRobots(
      'User-agent: *\nDisallow: /private\nAllow: /private/ok\nCrawl-delay: 2',
    );
    expect(robotsAllows(rules, '/public')).toBe(true);
    expect(robotsAllows(rules, '/private/x')).toBe(false);
    expect(robotsAllows(rules, '/private/ok')).toBe(true);
    expect(rules.crawlDelayMs).toBe(2000);
  });

  it('applies an Excalibur-specific group', () => {
    const rules = parseRobots('User-agent: Excalibur\nDisallow: /no\n\nUser-agent: *\nDisallow: /');
    expect(robotsAllows(rules, '/yes')).toBe(true);
    expect(robotsAllows(rules, '/no')).toBe(false);
  });
});

describe('RateLimiter', () => {
  it('reserves per host and resolves immediately when the slot is free', async () => {
    const limiter = new RateLimiter();
    const now = (): number => 1000; // fixed clock — no real timers in the test
    const started = Date.now();
    await limiter.wait('h', 500, now); // first hit on this host → free, no wait
    await limiter.wait('other', 500, now); // a different host is independent → no wait
    // Neither call slept (fresh per-host slots): the test stays well under the delay.
    expect(Date.now() - started).toBeLessThan(400);
  });
});

describe('politeFetch', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exc-polite-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fetches, caches, then serves the repeat from cache (no second page hit)', async () => {
    const cache = new WebCache({ baseDir: dir });
    let pageHits = 0;
    const fetchImpl = fakeFetch('User-agent: *\nAllow: /', { onPage: () => (pageHits += 1) });
    const first = await politeFetch(PUBLIC, { cache, fetchImpl, perHostDelayMs: 0 });
    expect(first.fromCache).toBe(false);
    expect(first.markdown).toContain('real body text');
    const second = await politeFetch(PUBLIC, { cache, fetchImpl, perHostDelayMs: 0 });
    expect(second.fromCache).toBe(true);
    expect(pageHits).toBe(1); // the page was fetched once; the repeat came from cache
  });

  it('throws RobotsDisallowedError for a disallowed path', async () => {
    const fetchImpl = fakeFetch('User-agent: *\nDisallow: /');
    await expect(
      politeFetch(`${PUBLIC}secret`, { fetchImpl, perHostDelayMs: 0 }),
    ).rejects.toBeInstanceOf(RobotsDisallowedError);
  });

  it('ignores robots when respectRobots is false', async () => {
    const fetchImpl = fakeFetch('User-agent: *\nDisallow: /');
    const res = await politeFetch(PUBLIC, { fetchImpl, respectRobots: false, perHostDelayMs: 0 });
    expect(res.markdown).toContain('real body text');
  });
});
