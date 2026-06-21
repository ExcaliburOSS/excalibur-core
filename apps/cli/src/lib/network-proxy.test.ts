import { afterEach, describe, expect, it } from 'vitest';
import {
  Agent,
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from 'undici';
import { installNetworkProxy, redactProxyUrl, resolveNetworkPlan } from './network-proxy';

/** Env that opts into trusting the repo `.excalibur/config.yaml` network.* section. */
const TRUST = { EXCALIBUR_TRUST_REPO_NETWORK: '1' } as const;

describe('resolveNetworkPlan — trust model', () => {
  it('is a no-op with no env and no config', () => {
    const plan = resolveNetworkPlan(undefined, {});
    expect(plan.proxy).toBe(false);
    expect(plan.caFile).toBeNull();
    expect(plan.insecure).toBe(false);
    expect(plan.envPatch).toEqual({});
  });

  it('IGNORES repo config proxy without the trust opt-in (clone-a-repo egress hijack)', () => {
    const plan = resolveNetworkPlan({ proxy: { https: 'http://evil.example:8080' } }, {});
    expect(plan.proxy).toBe(false);
    expect(plan.notes.some((n) => /EXCALIBUR_TRUST_REPO_NETWORK/.test(n))).toBe(true);
  });

  it('honors repo config proxy WHEN the operator opts in', () => {
    const plan = resolveNetworkPlan({ proxy: { https: 'http://proxy.corp:8080' } }, { ...TRUST });
    expect(plan.proxy).toBe(true);
    expect(plan.httpsProxy).toBe('http://proxy.corp:8080');
  });

  it('honors env proxy unconditionally (no opt-in needed) and covers both schemes', () => {
    const plan = resolveNetworkPlan(undefined, { HTTP_PROXY: 'http://p.corp:3128' });
    expect(plan.proxy).toBe(true);
    // a single configured proxy covers BOTH schemes (undici fallback).
    expect(plan.httpProxy).toBe('http://p.corp:3128');
    expect(plan.httpsProxy).toBe('http://p.corp:3128');
    expect((plan.envPatch.NO_PROXY ?? '').split(',')).toEqual(
      expect.arrayContaining(['localhost', '127.0.0.1', '::1']),
    );
  });

  it('lets env win over a trusted config proxy', () => {
    const plan = resolveNetworkPlan(
      { proxy: { https: 'http://config:1' } },
      { ...TRUST, HTTPS_PROXY: 'http://env:9' },
    );
    expect(plan.httpsProxy).toBe('http://env:9');
  });
});

describe('resolveNetworkPlan — validation & redaction', () => {
  it('treats an empty-string proxy as unset', () => {
    const plan = resolveNetworkPlan(undefined, { HTTPS_PROXY: '', http_proxy: '   ' });
    expect(plan.proxy).toBe(false);
  });

  it('rejects an unsupported proxy scheme with a note', () => {
    const plan = resolveNetworkPlan(undefined, { HTTPS_PROXY: 'socks5://internal:1080' });
    expect(plan.proxy).toBe(false);
    expect(plan.notes.some((n) => /unsupported scheme/.test(n))).toBe(true);
  });

  it('redacts inline proxy credentials in notes', () => {
    const plan = resolveNetworkPlan(undefined, { HTTPS_PROXY: 'http://user:s3cret@p.corp:8080' });
    const joined = plan.notes.join(' | ');
    expect(joined).not.toContain('s3cret');
    expect(joined).toContain('***');
  });

  it('warns that a proxy bypasses the per-IP SSRF re-check', () => {
    const plan = resolveNetworkPlan(undefined, { HTTPS_PROXY: 'http://p.corp:8080' });
    expect(plan.notes.some((n) => /SSRF/.test(n))).toBe(true);
  });

  it('redactProxyUrl masks credentials', () => {
    expect(redactProxyUrl('http://u:p@h:8080/')).toContain('***');
    expect(redactProxyUrl('http://h:8080/')).toBe('http://h:8080/');
  });
});

describe('resolveNetworkPlan — custom CA precedence', () => {
  it('env NODE_EXTRA_CA_CERTS wins over a trusted config caFile', () => {
    const plan = resolveNetworkPlan(
      { tls: { caFile: '/config-ca.pem' } },
      { ...TRUST, NODE_EXTRA_CA_CERTS: '/env-ca.pem' },
    );
    expect(plan.caFile).toBeNull(); // env wins → config CA not injected
    expect(plan.notes.some((n) => /NODE_EXTRA_CA_CERTS/.test(n))).toBe(true);
  });

  it('uses the trusted config caFile when the env var is unset (mirrors it for children)', () => {
    const plan = resolveNetworkPlan({ tls: { caFile: '/corp-ca.pem' } }, { ...TRUST });
    expect(plan.caFile).toBe('/corp-ca.pem');
    expect(plan.envPatch.NODE_EXTRA_CA_CERTS).toBe('/corp-ca.pem');
  });

  it('ignores a config caFile without the trust opt-in', () => {
    const plan = resolveNetworkPlan({ tls: { caFile: '/corp-ca.pem' } }, {});
    expect(plan.caFile).toBeNull();
  });

  it('flags rejectUnauthorized:false only from trusted config', () => {
    expect(resolveNetworkPlan({ tls: { rejectUnauthorized: false } }, { ...TRUST }).insecure).toBe(
      true,
    );
    expect(resolveNetworkPlan({ tls: { rejectUnauthorized: false } }, {}).insecure).toBe(false);
  });
});

describe('installNetworkProxy', () => {
  it('installs nothing when there is no proxy and no CA/insecure', () => {
    let applied: Dispatcher | null = null;
    const result = installNetworkProxy(undefined, { env: {}, apply: (d) => (applied = d) });
    expect(result.installed).toBe(false);
    expect(applied).toBeNull();
  });

  it('installs a proxy dispatcher (env) and mirrors it for children', () => {
    const env: NodeJS.ProcessEnv = {};
    let applied: Dispatcher | null = null;
    const result = installNetworkProxy(undefined, {
      env: { ...env, HTTPS_PROXY: 'http://proxy.corp:8080' },
      apply: (d) => (applied = d),
    });
    expect(result.installed).toBe(true);
    expect(applied).not.toBeNull();
  });

  it('reads a trusted config caFile and installs a TLS Agent (no proxy)', () => {
    let applied: Dispatcher | null = null;
    const result = installNetworkProxy(
      { tls: { caFile: '/corp-ca.pem' } },
      { env: { ...TRUST }, apply: (d) => (applied = d), readFile: () => '----BEGIN CERT----' },
    );
    expect(result.installed).toBe(true);
    expect(applied).not.toBeNull();
  });

  it('records a note when the caFile cannot be read (never throws)', () => {
    const result = installNetworkProxy(
      { tls: { caFile: '/nope.pem' } },
      {
        env: { ...TRUST },
        apply: () => undefined,
        readFile: () => {
          throw new Error('ENOENT');
        },
      },
    );
    expect(result.notes.some((n) => /failed to read/.test(n))).toBe(true);
  });

  it('installs a proxy + custom-CA dispatcher (requestTls path, trusted config)', () => {
    let applied: Dispatcher | null = null;
    const result = installNetworkProxy(
      { proxy: { https: 'http://proxy.corp:8080' }, tls: { caFile: '/corp-ca.pem' } },
      { env: { ...TRUST }, apply: (d) => (applied = d), readFile: () => '----CERT----' },
    );
    expect(result.installed).toBe(true);
    expect(applied).toBeInstanceOf(EnvHttpProxyAgent);
  });
});

describe('installNetworkProxy — real global dispatcher', () => {
  const saved = getGlobalDispatcher();
  afterEach(() => setGlobalDispatcher(saved));

  it('installs a proxy agent as the REAL process-global undici dispatcher', () => {
    const before = getGlobalDispatcher();
    const result = installNetworkProxy(undefined, {
      env: { HTTPS_PROXY: 'http://proxy.corp:8080' },
    });
    expect(result.installed).toBe(true);
    expect(getGlobalDispatcher()).not.toBe(before);
    expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it('installs a plain TLS Agent when only a (trusted) custom CA is configured', () => {
    const result = installNetworkProxy(
      { tls: { caFile: '/x.pem' } },
      { env: { ...TRUST }, readFile: () => '--CERT--' },
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
