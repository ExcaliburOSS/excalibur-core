import { ProviderError } from '@excalibur/shared';
import { describe, expect, it } from 'vitest';
import {
  isRetryableProviderError,
  mapHttpError,
  networkError,
  parseRetryAfterMs,
  PROVIDER_ERROR_CODES,
  timeoutError,
} from './provider-errors';

describe('mapHttpError', () => {
  it.each([
    [400, PROVIDER_ERROR_CODES.invalidRequest],
    [401, PROVIDER_ERROR_CODES.authFailed],
    [403, PROVIDER_ERROR_CODES.authFailed],
    [404, PROVIDER_ERROR_CODES.modelNotFound],
    [429, PROVIDER_ERROR_CODES.rateLimited],
    [500, PROVIDER_ERROR_CODES.serverError],
    [503, PROVIDER_ERROR_CODES.serverError],
  ])('maps HTTP %s → %s', (status, code) => {
    const error = mapHttpError(status, '{}');
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe(code);
    expect(error.details?.['status']).toBe(status);
  });

  it('redacts secrets echoed in the error body before storing a snippet', () => {
    const body = 'invalid key sk-ant-api03-EXAMPLEKEY1234567890abcdEXAMPLE supplied';
    const error = mapHttpError(401, body);
    const snippet = String(error.details?.['body']);
    expect(snippet).toContain('[REDACTED]');
    expect(snippet).not.toContain('sk-ant-api03-EXAMPLEKEY1234567890abcdEXAMPLE');
  });

  it('attaches a parsed Retry-After header as retryAfterMs', () => {
    const error = mapHttpError(429, '{}', { 'retry-after': '3' });
    expect(error.details?.['retryAfterMs']).toBe(3000);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('30')).toBe(30000);
  });
  it('returns null for an HTTP-date or empty value', () => {
    expect(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
  });
});

describe('isRetryableProviderError', () => {
  it('is true for rate_limited / server_error / timeout / network_error', () => {
    expect(isRetryableProviderError(mapHttpError(429, ''))).toBe(true);
    expect(isRetryableProviderError(mapHttpError(500, ''))).toBe(true);
    expect(isRetryableProviderError(timeoutError(1000))).toBe(true);
    expect(isRetryableProviderError(networkError(new Error('ECONNRESET')))).toBe(true);
  });

  it('is false for auth / invalid / model-not-found and non-ProviderErrors', () => {
    expect(isRetryableProviderError(mapHttpError(401, ''))).toBe(false);
    expect(isRetryableProviderError(mapHttpError(400, ''))).toBe(false);
    expect(isRetryableProviderError(mapHttpError(404, ''))).toBe(false);
    expect(isRetryableProviderError(new Error('plain'))).toBe(false);
  });
});

describe('networkError', () => {
  it('redacts a secret leaked into the cause message', () => {
    const error = networkError(new Error('failed with key sk-proj-ABCDEFGHIJ1234567890KLMNOP'));
    expect(error.code).toBe(PROVIDER_ERROR_CODES.networkError);
    expect(error.message).toContain('[REDACTED]');
    expect(error.message).not.toContain('sk-proj-ABCDEFGHIJ1234567890KLMNOP');
  });
});
