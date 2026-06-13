import { describe, expect, it } from 'vitest';
import * as pkg from './index';
import type { EnterpriseConfig, EnterpriseSyncClient } from './index';

describe('@excalibur/enterprise-sync public API (Build Contract §4.8)', () => {
  it('exports the pinned runtime surface', () => {
    expect(typeof pkg.HttpEnterpriseSyncClient).toBe('function');
    expect(typeof pkg.loadCliCredentials).toBe('function');
    expect(typeof pkg.saveCliCredentials).toBe('function');
    expect(pkg.enterpriseConfigSchema).toBeDefined();
    expect(pkg.SYNC_FAILED_CODE).toBe('sync_failed');
  });

  it('validates EnterpriseConfig with all sections optional', () => {
    const empty = pkg.enterpriseConfigSchema.safeParse({});
    expect(empty.success).toBe(true);

    const full = pkg.enterpriseConfigSchema.safeParse({
      allowedModels: ['mock'],
      workflows: [{ id: 'fast-fix' }],
      policies: [{ id: 'standard-safe' }],
      teamDefaults: { autonomyDefault: 2 },
      sensitivePaths: ['src/auth/**'],
    });
    expect(full.success).toBe(true);

    const invalid = pkg.enterpriseConfigSchema.safeParse({ sensitivePaths: [42] });
    expect(invalid.success).toBe(false);
  });

  it('HttpEnterpriseSyncClient is assignable to the EnterpriseSyncClient interface', () => {
    const client: EnterpriseSyncClient = new pkg.HttpEnterpriseSyncClient({
      baseUrl: 'https://enterprise.example.com',
      apiKey: 'k',
    });
    expect(typeof client.pushRun).toBe('function');
    expect(typeof client.pushEvent).toBe('function');
    expect(typeof client.pullConfig).toBe('function');
  });

  it('EnterpriseConfig type matches the pinned shape', () => {
    // Compile-time assertion: the pinned fields type-check exactly.
    const config: EnterpriseConfig = {
      allowedModels: ['mock'],
      workflows: [],
      policies: [],
      teamDefaults: {},
      sensitivePaths: [],
    };
    expect(config.allowedModels).toEqual(['mock']);
  });
});
