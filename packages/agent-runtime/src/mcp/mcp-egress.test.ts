import { describe, expect, it } from 'vitest';
import { PermissionEngine } from '../permissions/permission-engine';
import { assertServerEgress, checkServerEgress } from './mcp-egress';

describe('checkServerEgress', () => {
  it('allows a public endpoint under the default network policy', () => {
    const engine = new PermissionEngine();
    expect(checkServerEgress('https://api.example.com/mcp', engine, undefined).allowed).toBe(true);
  });

  it('denies when the global network is off', () => {
    const engine = new PermissionEngine({ network: { mode: 'off', approval: 'ask' } });
    const v = checkServerEgress('https://api.example.com/mcp', engine, undefined);
    expect(v.allowed).toBe(false);
  });

  it('enforces a per-server egress allowlist', () => {
    const engine = new PermissionEngine();
    const egress = { allowedDomains: ['*.github.com'] };
    expect(checkServerEgress('https://api.example.com/mcp', engine, egress).allowed).toBe(false);
    expect(checkServerEgress('https://api.github.com/mcp', engine, egress).allowed).toBe(true);
  });
});

describe('assertServerEgress', () => {
  it('allows a public-IP endpoint (resolves public, no DNS needed)', async () => {
    const engine = new PermissionEngine();
    const v = await assertServerEgress('http://93.184.216.34/mcp', engine, undefined);
    expect(v.allowed).toBe(true);
  });

  it('denies a loopback endpoint (SSRF floor)', async () => {
    const engine = new PermissionEngine();
    const v = await assertServerEgress('http://127.0.0.1/mcp', engine, undefined);
    expect(v.allowed).toBe(false);
  });

  it('allows a private endpoint only when explicitly allow-listed', async () => {
    const engine = new PermissionEngine({
      network: { mode: 'on', approval: 'auto', allowPrivateHosts: ['127.0.0.1'] },
    });
    const v = await assertServerEgress('http://127.0.0.1/mcp', engine, {
      allowPrivateHosts: ['127.0.0.1'],
    });
    expect(v.allowed).toBe(true);
  });
});
