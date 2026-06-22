/**
 * Typed API client for the dashboard. Talks to the same `excalibur serve`
 * instance that served this page, reusing the per-process token carried in the
 * page URL (`?token=…`) — exactly how the legacy dashboard authenticated. Every
 * response is typed against the shared dashboard contracts.
 */
import type { BoardResponse, RunSummary, WorkItemDetail } from './contracts';

/** The token the server embedded in this page's URL (query or hash). */
function authToken(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('token');
  if (fromQuery !== null && fromQuery.length > 0) {
    return fromQuery;
  }
  // Hash router keeps `#/path`; a token may live before the hash only, but guard
  // a `?token=` that ended up in the hash fragment too.
  const hash = window.location.hash;
  const q = hash.indexOf('?');
  if (q !== -1) {
    const t = new URLSearchParams(hash.slice(q + 1)).get('token');
    if (t !== null && t.length > 0) {
      return t;
    }
  }
  return '';
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { Authorization: `Bearer ${authToken()}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === 'string') {
        detail = body.error;
      }
    } catch {
      /* non-JSON error body — keep statusText */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

/** Health probe (also confirms the token is valid). */
export const fetchHealth = (): Promise<{ ok: boolean; service: string; repoRoot: string }> =>
  get('/health');

/** The kanban board (D1). */
export const fetchBoard = (): Promise<BoardResponse> => get('/api/board');

/** A work item with its linked runs / PRs / plans (D1/D2/D3). */
export const fetchWorkItem = (key: string): Promise<WorkItemDetail> =>
  get(`/api/work-items/${encodeURIComponent(key)}`);

/** All runs (the runs explorer, D4). The server returns full RunRecords; the
 * explorer only needs the summary fields, which RunSummary is a subset of. */
export const fetchRuns = (): Promise<{ runs: RunSummary[] }> => get('/api/runs');

/** Aggregate insights for the analytics view (D4). */
export const fetchInsights = (): Promise<Record<string, unknown>> => get('/api/insights');

export { authToken };
