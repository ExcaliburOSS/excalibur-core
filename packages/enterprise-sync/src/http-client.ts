/**
 * HTTP implementation of the Enterprise sync client (Build Contract §4.8).
 *
 * Talks to the Excalibur Enterprise control plane via the global `fetch`
 * (Node ≥ 22): `POST {base}/api/sync/runs`, `POST {base}/api/sync/events`,
 * `GET {base}/api/sync/config`, authenticating with an
 * `Authorization: Bearer <apiKey>` header.
 *
 * @experimental Experimental in M1 — the Enterprise API is not public yet and
 * the endpoints/payloads may change. Sync is strictly optional: callers must
 * degrade gracefully when these methods throw.
 */
import { ConfigValidationError, ProviderError } from '@excalibur/shared';
import type { ExcaliburEvent, LocalRun } from '@excalibur/shared';
import { buildBodyExcerpt } from './redact';
import { enterpriseConfigSchema } from './types';
import type { EnterpriseConfig, EnterpriseSyncClient } from './types';

/** Stable `ProviderError.code` for every sync failure. */
export const SYNC_FAILED_CODE = 'sync_failed';

/**
 * Constructor options for {@link HttpEnterpriseSyncClient}.
 *
 * @experimental
 */
export interface HttpEnterpriseSyncClientOptions {
  /** Enterprise API base URL (scheme + host, optional path prefix). */
  baseUrl: string;
  /** Enterprise API key, sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /**
   * Fetch implementation; defaults to the global `fetch`. Injectable for
   * tests — production code should not pass it.
   */
  fetchImpl?: typeof fetch;
}

/**
 * `EnterpriseSyncClient` over HTTP.
 *
 * Failure contract: any non-2xx response, network failure or malformed
 * response body is thrown as a `ProviderError` with code `sync_failed`. For
 * HTTP failures, `details` carries the status code and a redacted,
 * length-capped excerpt of the response body — never the API key.
 *
 * @experimental Experimental in M1.
 */
export class HttpEnterpriseSyncClient implements EnterpriseSyncClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpEnterpriseSyncClientOptions) {
    const baseUrl = opts.baseUrl.trim().replace(/\/+$/, '');
    if (baseUrl.length === 0) {
      throw new ConfigValidationError('Enterprise sync baseUrl must not be empty');
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new ConfigValidationError('Enterprise sync baseUrl must be an http(s) URL', {
        baseUrl,
      });
    }
    if (opts.apiKey.trim().length === 0) {
      throw new ConfigValidationError('Enterprise sync apiKey must not be empty');
    }
    this.baseUrl = baseUrl;
    this.apiKey = opts.apiKey.trim();
    // Resolve the global lazily so the client never holds a stale reference
    // (and avoids illegal-invocation issues with bound platform functions).
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** Pushes a local run record to `POST {base}/api/sync/runs`. @experimental */
  async pushRun(run: LocalRun): Promise<void> {
    await this.request('POST', '/api/sync/runs', run);
  }

  /** Pushes a single event to `POST {base}/api/sync/events`. @experimental */
  async pushEvent(event: ExcaliburEvent): Promise<void> {
    await this.request('POST', '/api/sync/events', event);
  }

  /**
   * Pulls Enterprise configuration from `GET {base}/api/sync/config`
   * (optionally scoped with a `repositoryId` query parameter).
   *
   * @experimental
   */
  async pullConfig(repositoryId?: string): Promise<EnterpriseConfig> {
    const query =
      repositoryId !== undefined && repositoryId.length > 0
        ? `?repositoryId=${encodeURIComponent(repositoryId)}`
        : '';
    const response = await this.request('GET', `/api/sync/config${query}`);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderError('Enterprise sync config response is not valid JSON', {
        code: SYNC_FAILED_CODE,
        details: { url: `${this.baseUrl}/api/sync/config`, status: response.status },
      });
    }

    const result = enterpriseConfigSchema.safeParse(payload);
    if (!result.success) {
      throw new ProviderError('Enterprise sync config response has an invalid shape', {
        code: SYNC_FAILED_CODE,
        details: {
          url: `${this.baseUrl}/api/sync/config`,
          status: response.status,
          issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        },
      });
    }
    return result.data;
  }

  private async request(method: 'GET' | 'POST', pathname: string, body?: unknown): Promise<Response> {
    const url = `${this.baseUrl}${pathname}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      throw new ProviderError(`Enterprise sync request failed: ${method} ${url}`, {
        code: SYNC_FAILED_CODE,
        details: {
          method,
          url,
          cause: error instanceof Error ? error.message : String(error),
        },
      });
    }

    if (!response.ok) {
      throw new ProviderError(
        `Enterprise sync request failed with HTTP ${response.status}: ${method} ${url}`,
        {
          code: SYNC_FAILED_CODE,
          details: {
            method,
            url,
            status: response.status,
            bodyExcerpt: await this.safeBodyExcerpt(response),
          },
        },
      );
    }
    return response;
  }

  private async safeBodyExcerpt(response: Response): Promise<string> {
    let body: string;
    try {
      body = await response.text();
    } catch {
      return '';
    }
    return buildBodyExcerpt(body, [this.apiKey]);
  }
}
