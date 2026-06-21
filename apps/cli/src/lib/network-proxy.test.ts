import { afterEach, describe, expect, it } from 'vitest';
import {
  Agent,
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from 'undici';
import { installNetworkProxy, resolveNetworkPlan } from './network-proxy';

describe('resolveNetworkPlan', () => {
  it('is a no-op with no env and no config', () => {
    const plan = resolveNetworkPlan(undefined, {});
    expect(plan.proxy).toBe(false);
    expect(plan.caFile).toBeNull();
    expect(plan.insecure).toBe(false);
    expect(plan.envPatch).toEqual({});
  });

  it('uses config proxy when env is unset and always bypasses loopback', () => {
    const plan = resolveNetworkPlan(
      { proxy: { https: 'http://proxy.corp:8080', noProxy: 'internal.corp' } },
      {},
    );
    expect(plan.proxy).toBe(true);
    expect(plan.envPatch.HTTPS_PROXY).toBe('http://proxy.corp:8080');
    // loopback always bypassed, merged with the configured no-proxy host.
    expect((plan.envPatch.NO_PROXY ?? '').split(',')).toEqual(
      expect.arrayContaining(['localhost', '127.0.0.1', '::1', 'internal.corp']),
    );
  });

  it('lets env win over config (env proxy used, no envPatch for it)', () => {
    const plan = resolveNetworkPlan(
      { proxy: { https: 'http://config-proxy:1' } },
      { HTTPS_PROXY: 'http://env-proxy:9' },
    );
    expect(plan.proxy).toBe(true);
    // env already set → not overwritten; NO_PROXY still gets loopback.
    expect(plan.envPatch.HTTPS_PROXY).toBeUndefined();
    expect((plan.envPatch.NO_PROXY ?? '').split(',')).toContain('localhost');
  });

  it('mirrors a config caFile into NODE_EXTRA_CA_CERTS (for children) when env unset', () => {
    const plan = resolveNetworkPlan({ tls: { caFile: '/etc/corp-ca.pem' } }, {});
    expect(plan.caFile).toBe('/etc/corp-ca.pem');
    expect(plan.envPatch.NODE_EXTRA_CA_CERTS).toBe('/etc/corp-ca.pem');
  });

  it('does not override an existing NODE_EXTRA_CA_CERTS', () => {
    const plan = resolveNetworkPlan(
      { tls: { caFile: '/etc/corp-ca.pem' } },
      { NODE_EXTRA_CA_CERTS: '/already/set.pem' },
    );
    expect(plan.envPatch.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it('flags rejectUnauthorized:false as insecure', () => {
    const plan = resolveNetworkPlan({ tls: { rejectUnauthorized: false } }, {});
    expect(plan.insecure).toBe(true);
    expect(plan.notes.some((n) => /INSECURE/.test(n))).toBe(true);
  });
});

describe('installNetworkProxy', () => {
  it('installs nothing when there is no proxy and no CA/insecure', () => {
    let applied: Dispatcher | null = null;
    const result = installNetworkProxy(undefined, { env: {}, apply: (d) => (applied = d) });
    expect(result.installed).toBe(false);
    expect(applied).toBeNull();
  });

  it('installs a proxy dispatcher and mirrors config into the env', () => {
    const env: NodeJS.ProcessEnv = {};
    let applied: Dispatcher | null = null;
    const result = installNetworkProxy(
      { proxy: { https: 'http://proxy.corp:8080' } },
      { env, apply: (d) => (applied = d) },
    );
    expect(result.installed).toBe(true);
    expect(applied).not.toBeNull();
    expect(env.HTTPS_PROXY).toBe('http://proxy.corp:8080');
    expect(env.NO_PROXY).toContain('localhost');
  });

  it('reads the config caFile and installs a TLS dispatcher (no proxy)', () => {
    const env: NodeJS.ProcessEnv = {};
    let applied: Dispatcher | null = null;
    const result = installNetworkProxy(
      { tls: { caFile: '/etc/corp-ca.pem' } },
      { env, apply: (d) => (applied = d), readFile: () => '----BEGIN CERT----' },
    );
    expect(result.installed).toBe(true);
    expect(applied).not.toBeNull();
  });

  it('records a note when the caFile cannot be read (never throws)', () => {
    const result = installNetworkProxy(
      { tls: { caFile: '/nope.pem' } },
      {
        env: {},
        apply: () => undefined,
        readFile: () => {
          throw new Error('ENOENT');
        },
      },
    );
    expect(result.notes.some((n) => /failed to read/.test(n))).toBe(true);
  });
});

describe('installNetworkProxy — real global dispatcher', () => {
  const saved = getGlobalDispatcher();
  afterEach(() => setGlobalDispatcher(saved));

  it('installs a proxy agent as the REAL process-global undici dispatcher', () => {
    const before = getGlobalDispatcher();
    const result = installNetworkProxy({ proxy: { https: 'http://proxy.corp:8080' } }, { env: {} });
    expect(result.installed).toBe(true);
    const after = getGlobalDispatcher();
    expect(after).not.toBe(before);
    // The real dispatcher Node's global fetch consults is now our proxy agent.
    expect(after).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it('installs a plain TLS Agent (no proxy) when only a custom CA is configured', () => {
    const result = installNetworkProxy(
      { tls: { caFile: '/x.pem' } },
      { env: {}, readFile: () => '--CERT--' },
    );
    expect(result.installed).toBe(true);
    expect(getGlobalDispatcher()).toBeInstanceOf(Agent);
  });

  it('leaves the global dispatcher untouched when nothing is configured', () => {
    const before = getGlobalDispatcher();
    const result = installNetworkProxy(undefined, { env: {} });
    expect(result.installed).toBe(false);
    expect(getGlobalDispatcher()).toBe(before);
  });
});
