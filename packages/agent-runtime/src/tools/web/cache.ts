import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * On-disk content cache for the web tools (F4, the transversal cache the F2 plan
 * deferred). Stores normalized markdown keyed by `sha256(url)` so a `web_crawl`
 * (or a repeat `web_fetch`) can serve unchanged pages from disk via conditional
 * GET (ETag / Last-Modified) instead of re-downloading — saving time, bandwidth
 * and (for paid tiers) money.
 *
 * Each entry is a sidecar JSON `<key>.json` plus a `<key>.md` body, under
 * `~/.cache/excalibur/web/` (XDG_CACHE_HOME aware; `baseDir` injectable for
 * tests). Files are mode 0o600. Only 2xx normalized markdown is cached, never a
 * blocked/binary content-type. TTL-bounded with an LRU prune at `maxEntries`.
 */

export interface CacheEntry {
  url: string;
  etag?: string;
  lastModified?: string;
  fetchedAt: string;
  contentType: string;
  title: string;
  bytes: number;
}

export interface CachedRead extends CacheEntry {
  markdown: string;
}

export interface WebCacheOptions {
  /** Cache root (defaults to $XDG_CACHE_HOME/excalibur/web or ~/.cache/excalibur/web). */
  baseDir?: string;
  /** Entry time-to-live in ms (default 24h). Expired entries are treated as misses. */
  ttlMs?: number;
  /** Max entries before an LRU prune runs on write (default 2000). */
  maxEntries?: number;
}

const DEFAULT_TTL_MS = 86_400_000; // 24h
const DEFAULT_MAX_ENTRIES = 2000;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function defaultBaseDir(): string {
  const xdg = process.env['XDG_CACHE_HOME'];
  const root = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), '.cache');
  return join(root, 'excalibur', 'web');
}

export class WebCache {
  private readonly baseDir: string;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: WebCacheOptions = {}) {
    this.baseDir = options.baseDir ?? defaultBaseDir();
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  private keyOf(url: string): string {
    return createHash('sha256').update(url).digest('hex');
  }

  private metaPath(key: string): string {
    return join(this.baseDir, `${key}.json`);
  }

  private bodyPath(key: string): string {
    return join(this.baseDir, `${key}.md`);
  }

  /** Returns the cached entry+markdown for `url`, or null on miss/expired/corrupt. */
  get(url: string): CachedRead | null {
    const key = this.keyOf(url);
    const metaPath = this.metaPath(key);
    const bodyPath = this.bodyPath(key);
    if (!existsSync(metaPath) || !existsSync(bodyPath)) {
      return null;
    }
    try {
      const entry = JSON.parse(readFileSync(metaPath, 'utf8')) as CacheEntry;
      const age = Date.now() - new Date(entry.fetchedAt).getTime();
      if (!Number.isFinite(age) || age > this.ttlMs) {
        return null;
      }
      return { ...entry, markdown: readFileSync(bodyPath, 'utf8') };
    } catch {
      return null;
    }
  }

  /** The validator entry (etag/lastModified) for a conditional GET, even if the body is stale. */
  validators(url: string): { etag?: string; lastModified?: string } | null {
    const metaPath = this.metaPath(this.keyOf(url));
    if (!existsSync(metaPath)) {
      return null;
    }
    try {
      const entry = JSON.parse(readFileSync(metaPath, 'utf8')) as CacheEntry;
      return {
        ...(entry.etag !== undefined ? { etag: entry.etag } : {}),
        ...(entry.lastModified !== undefined ? { lastModified: entry.lastModified } : {}),
      };
    } catch {
      return null;
    }
  }

  /** Stores normalized markdown for `url`. Refreshes `fetchedAt` for TTL/LRU. */
  put(url: string, entry: Omit<CacheEntry, 'url' | 'fetchedAt'>, markdown: string): void {
    mkdirSync(this.baseDir, { recursive: true, mode: DIR_MODE });
    const key = this.keyOf(url);
    const full: CacheEntry = {
      url,
      fetchedAt: new Date().toISOString(),
      ...entry,
    };
    writeFileSync(this.bodyPath(key), markdown, { mode: FILE_MODE });
    writeFileSync(this.metaPath(key), JSON.stringify(full), { mode: FILE_MODE });
    this.prune();
  }

  /** LRU-prune by `fetchedAt` (oldest first) when over `maxEntries`. */
  private prune(): void {
    let metas: string[];
    try {
      metas = readdirSync(this.baseDir).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }
    if (metas.length <= this.maxEntries) {
      return;
    }
    const dated = metas.map((file) => {
      let when = 0;
      try {
        when = statSync(join(this.baseDir, file)).mtimeMs;
      } catch {
        when = 0;
      }
      return { file, when };
    });
    dated.sort((a, b) => a.when - b.when);
    const toRemove = dated.slice(0, dated.length - this.maxEntries);
    for (const { file } of toRemove) {
      const key = file.replace(/\.json$/, '');
      rmSync(this.metaPath(key), { force: true });
      rmSync(this.bodyPath(key), { force: true });
    }
  }
}
