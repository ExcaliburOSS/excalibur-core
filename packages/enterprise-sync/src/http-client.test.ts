import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigValidationError,
  ProviderError,
  createEvent,
  isExcaliburError,
} from '@excalibur/shared';
import type { LocalRun } from '@excalibur/shared';
import { HttpEnterpriseSyncClient, SYNC_FAILED_CODE } from './http-client';

const API_KEY = 'exc_secret_api_key_12345';
const BASE_URL = 'https://enterprise.example.com';

const RUN: LocalRun = {
  id: 'run_20260613_101500',
  dir: '/repo/.excalibur/runs/run_20260613_101500',
  record: {
    id: 'run_20260613_101500',
    title: 'Fix duplicate escrow release',
    autonomyLevel: 3,
    workflow: 'fast-fix',
    methodology: null,
    status: 'completed',
    model: 'mock',
    executionStyle: 'fast',
    startedAt: '2026-06-13T10:15:00.000Z',
    completedAt: '2026-06-13T10:16:30.000Z',
  },
};

const EVENT = createEvent({
  runId: RUN.id,
  type: 'run_completed',
  payload: { status: 'completed' },
});

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

function createStubFetch(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { stub: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const stub: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return responder(url, init);
  };
  return { stub, calls };
}

function headersOf(call: RecordedCall): Record<string, string> {
  return (call.init?.headers ?? {}) as Record<string, string>;
}

function createClient(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
  opts: { baseUrl?: string; apiKey?: string } = {},
): { client: HttpEnterpriseSyncClient; calls: RecordedCall[] } {
  const { stub, calls } = createStubFetch(responder);
  const client = new HttpEnterpriseSyncClient({
    baseUrl: opts.baseUrl ?? BASE_URL,
    apiKey: opts.apiKey ?? API_KEY,
    fetchImpl: stub,
  });
  return { client, calls };
}

async function expectSyncFailed(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(isExcaliburError(error)).toBe(true);
    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.code).toBe(SYNC_FAILED_CODE);
    return providerError;
  }
  return expect.unreachable('expected the sync call to throw') as never;
}

describe('HttpEnterpriseSyncClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('constructor', () => {
    it('rejects an empty baseUrl', () => {
      expect(() => new HttpEnterpriseSyncClient({ baseUrl: '  ', apiKey: API_KEY })).toThrow(
        ConfigValidationError,
      );
    });

    it('rejects a non-http(s) baseUrl', () => {
      expect(
        () => new HttpEnterpriseSyncClient({ baseUrl: 'ftp://example.com', apiKey: API_KEY }),
      ).toThrow(ConfigValidationError);
    });

    it('rejects an empty apiKey', () => {
      expect(() => new HttpEnterpriseSyncClient({ baseUrl: BASE_URL, apiKey: '' })).toThrow(
        ConfigValidationError,
      );
    });
  });

  describe('pushRun', () => {
    it('POSTs the run as JSON to {base}/api/sync/runs with a Bearer header', async () => {
      const { client, calls } = createClient(() => new Response(null, { status: 202 }));

      await client.pushRun(RUN);

      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.url).toBe(`${BASE_URL}/api/sync/runs`);
      expect(call.init?.method).toBe('POST');
      const headers = headersOf(call);
      expect(headers['Authorization']).toBe(`Bearer ${API_KEY}`);
      expect(headers['Content-Type']).toBe('application/json');
      // The local absolute `dir` is sanitized to a repo-relative path so the
      // OS username / home directory / on-disk layout never leaks to the
      // control plane; everything else is sent verbatim.
      expect(JSON.parse(call.init?.body as string)).toEqual({
        ...RUN,
        dir: '.excalibur/runs/run_20260613_101500',
      });
    });

    it('never leaks the local absolute dir path in the pushed run', async () => {
      const { client, calls } = createClient(() => new Response(null, { status: 202 }));
      await client.pushRun(RUN);
      const body = calls[0]!.init?.body as string;
      expect(body).not.toContain('/repo/.excalibur');
      expect(JSON.parse(body).dir).toBe('.excalibur/runs/run_20260613_101500');
    });

    it('normalizes trailing slashes in the baseUrl', async () => {
      const { client, calls } = createClient(() => new Response(null, { status: 200 }), {
        baseUrl: `${BASE_URL}//`,
      });

      await client.pushRun(RUN);
      expect(calls[0]!.url).toBe(`${BASE_URL}/api/sync/runs`);
    });

    it('throws ProviderError sync_failed with status and redacted body excerpt on non-2xx', async () => {
      const body = `Forbidden for Authorization: Bearer ${API_KEY} (key ${API_KEY})`;
      const { client } = createClient(() => new Response(body, { status: 403 }));

      const error = await expectSyncFailed(client.pushRun(RUN));
      expect(error.message).toContain('403');
      expect(error.details).toMatchObject({
        status: 403,
        method: 'POST',
        url: `${BASE_URL}/api/sync/runs`,
      });
      const excerpt = error.details?.['bodyExcerpt'] as string;
      expect(excerpt).not.toContain(API_KEY);
      expect(excerpt).toContain('[REDACTED]');
    });

    it('caps the body excerpt for huge error responses', async () => {
      const { client } = createClient(() => new Response('x'.repeat(10_000), { status: 500 }));

      const error = await expectSyncFailed(client.pushRun(RUN));
      const excerpt = error.details?.['bodyExcerpt'] as string;
      expect(excerpt.length).toBeLessThan(300);
      expect(excerpt).toContain('(truncated)');
    });

    it('wraps network failures as ProviderError sync_failed', async () => {
      const { client } = createClient(() => {
        throw new Error('ECONNREFUSED 127.0.0.1:443');
      });

      const error = await expectSyncFailed(client.pushRun(RUN));
      expect(error.details?.['cause']).toContain('ECONNREFUSED');
    });
  });

  describe('pushEvent', () => {
    it('POSTs the event as JSON to {base}/api/sync/events', async () => {
      const { client, calls } = createClient(() => new Response(null, { status: 204 }));

      await client.pushEvent(EVENT);

      const call = calls[0]!;
      expect(call.url).toBe(`${BASE_URL}/api/sync/events`);
      expect(call.init?.method).toBe('POST');
      expect(headersOf(call)['Authorization']).toBe(`Bearer ${API_KEY}`);
      expect(JSON.parse(call.init?.body as string)).toEqual(EVENT);
    });

    it('throws ProviderError sync_failed on a 401', async () => {
      const { client } = createClient(() => new Response('unauthorized', { status: 401 }));

      const error = await expectSyncFailed(client.pushEvent(EVENT));
      expect(error.details?.['status']).toBe(401);
    });
  });

  describe('pullConfig', () => {
    const CONFIG_BODY = {
      allowedModels: ['mock', 'qwen'],
      sensitivePaths: ['src/billing/**'],
      teamDefaults: { autonomyDefault: 2 },
      workflows: [],
      policies: [{ id: 'standard-safe' }],
    };

    it('GETs {base}/api/sync/config and returns the parsed config', async () => {
      const { client, calls } = createClient(
        () =>
          new Response(JSON.stringify(CONFIG_BODY), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      );

      const config = await client.pullConfig();

      const call = calls[0]!;
      expect(call.url).toBe(`${BASE_URL}/api/sync/config`);
      expect(call.init?.method).toBe('GET');
      expect(headersOf(call)['Authorization']).toBe(`Bearer ${API_KEY}`);
      expect(call.init?.body).toBeUndefined();
      expect(config).toEqual(CONFIG_BODY);
    });

    it('scopes the request with an encoded repositoryId query parameter', async () => {
      const { client, calls } = createClient(() => new Response('{}', { status: 200 }));

      await client.pullConfig('org/repo name');
      expect(calls[0]!.url).toBe(`${BASE_URL}/api/sync/config?repositoryId=org%2Frepo%20name`);
    });

    it('accepts an empty object (no overrides) and preserves unknown keys', async () => {
      const { client } = createClient(
        () => new Response(JSON.stringify({ futureSection: { x: 1 } }), { status: 200 }),
      );

      const config = await client.pullConfig();
      expect(config).toEqual({ futureSection: { x: 1 } });
    });

    it('throws ProviderError sync_failed when the response is not valid JSON', async () => {
      const { client } = createClient(() => new Response('<html>oops</html>', { status: 200 }));

      await expectSyncFailed(client.pullConfig());
    });

    it('throws ProviderError sync_failed when the config shape is invalid', async () => {
      const { client } = createClient(
        () => new Response(JSON.stringify({ allowedModels: 'not-an-array' }), { status: 200 }),
      );

      const error = await expectSyncFailed(client.pullConfig());
      expect(error.details?.['issues']).toBeDefined();
    });

    it('throws ProviderError sync_failed with status on a 503', async () => {
      const { client } = createClient(() => new Response('upstream down', { status: 503 }));

      const error = await expectSyncFailed(client.pullConfig('repo-1'));
      expect(error.details?.['status']).toBe(503);
      expect(error.details?.['bodyExcerpt']).toBe('upstream down');
    });
  });

  describe('global fetch default', () => {
    it('uses globalThis.fetch when no fetchImpl is injected', async () => {
      const { stub, calls } = createStubFetch(() => new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', stub);

      const client = new HttpEnterpriseSyncClient({ baseUrl: BASE_URL, apiKey: API_KEY });
      await client.pushEvent(EVENT);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(`${BASE_URL}/api/sync/events`);
    });
  });
});
