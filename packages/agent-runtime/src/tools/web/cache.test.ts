import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebCache } from './cache';

describe('WebCache', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exc-cache-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const entry = { contentType: 'text/html', title: 'T', bytes: 3 };

  it('stores and serves a fresh entry', () => {
    const cache = new WebCache({ baseDir: dir });
    expect(cache.get('https://a.test/')).toBeNull();
    cache.put('https://a.test/', entry, 'abc');
    const hit = cache.get('https://a.test/');
    expect(hit?.markdown).toBe('abc');
    expect(hit?.title).toBe('T');
  });

  it('treats an expired entry as a miss', () => {
    const cache = new WebCache({ baseDir: dir, ttlMs: -1 });
    cache.put('https://b.test/', entry, 'xyz');
    expect(cache.get('https://b.test/')).toBeNull();
  });

  it('exposes validators for a conditional GET', () => {
    const cache = new WebCache({ baseDir: dir });
    cache.put('https://c.test/', { ...entry, etag: 'W/"123"' }, 'body');
    expect(cache.validators('https://c.test/')).toEqual({ etag: 'W/"123"' });
    expect(cache.validators('https://missing.test/')).toBeNull();
  });

  it('LRU-prunes when over maxEntries', () => {
    const cache = new WebCache({ baseDir: dir, maxEntries: 2 });
    cache.put('https://1.test/', entry, '1');
    cache.put('https://2.test/', entry, '2');
    cache.put('https://3.test/', entry, '3');
    const survivors = ['https://1.test/', 'https://2.test/', 'https://3.test/'].filter(
      (u) => cache.get(u) !== null,
    );
    expect(survivors.length).toBeLessThanOrEqual(2);
    // The most-recent write always survives.
    expect(cache.get('https://3.test/')).not.toBeNull();
  });
});
