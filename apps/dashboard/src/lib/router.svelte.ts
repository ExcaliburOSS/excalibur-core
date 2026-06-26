/**
 * Minimal hash router (Svelte 5 runes). Hash routing means the SPA needs zero
 * server-side route config — `excalibur serve` only ever serves `/`, and all
 * navigation lives in the `#/…` fragment. Reactive `current` drives `App.svelte`.
 */

export interface Route {
  /** Matched view name. */
  name:
    | 'board'
    | 'workItem'
    | 'runs'
    | 'run'
    | 'insights'
    | 'orchestrations'
    | 'orchestration'
    | 'plans'
    | 'scope'
    | 'missions'
    | 'sessions'
    | 'session'
    | 'scheduler'
    | 'threads'
    | 'search'
    | 'notFound';
  /** Path params (e.g. `{ key: 'WI-12' }`). */
  params: Record<string, string>;
}

const PATTERNS: { name: Route['name']; re: RegExp; keys: string[] }[] = [
  { name: 'board', re: /^\/?$/, keys: [] },
  { name: 'workItem', re: /^\/work-items\/([^/]+)$/, keys: ['key'] },
  { name: 'run', re: /^\/runs\/([^/]+)$/, keys: ['id'] },
  { name: 'runs', re: /^\/runs$/, keys: [] },
  { name: 'insights', re: /^\/insights$/, keys: [] },
  { name: 'orchestration', re: /^\/orchestrations\/([^/]+)$/, keys: ['id'] },
  { name: 'orchestrations', re: /^\/orchestrations$/, keys: [] },
  { name: 'plans', re: /^\/plans$/, keys: [] },
  { name: 'scope', re: /^\/scope$/, keys: [] },
  { name: 'missions', re: /^\/missions$/, keys: [] },
  { name: 'session', re: /^\/sessions\/([^/]+)$/, keys: ['id'] },
  { name: 'sessions', re: /^\/sessions$/, keys: [] },
  { name: 'scheduler', re: /^\/scheduler$/, keys: [] },
  { name: 'threads', re: /^\/threads$/, keys: [] },
  { name: 'search', re: /^\/search$/, keys: [] },
];

/** Parses the current `location.hash` (stripping any `?query`) into a Route. */
export function parseHash(hash: string): Route {
  let path = hash.replace(/^#/, '');
  const q = path.indexOf('?');
  if (q !== -1) {
    path = path.slice(0, q);
  }
  if (path.length === 0) {
    path = '/';
  }
  for (const { name, re, keys } of PATTERNS) {
    const m = re.exec(path);
    if (m !== null) {
      const params: Record<string, string> = {};
      keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1] ?? '');
      });
      return { name, params };
    }
  }
  return { name: 'notFound', params: {} };
}

/** Navigate to an in-app path (e.g. `navigate('/work-items/WI-3')`). */
export function navigate(path: string): void {
  window.location.hash = path;
}

/** A reactive store of the current route (runes). */
export function createRouter(): { readonly current: Route } {
  let current = $state(parseHash(window.location.hash));
  window.addEventListener('hashchange', () => {
    current = parseHash(window.location.hash);
  });
  return {
    get current() {
      return current;
    },
  };
}
