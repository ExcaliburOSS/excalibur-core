import { describe, expect, it } from 'vitest';
import { inspectUrl, isBlockedHostname, isBlockedIp } from './ssrf-guard';

describe('ssrf-guard / inspectUrl', () => {
  it('accepts http/https and rejects other schemes + garbage', () => {
    expect(inspectUrl('https://example.com/x')).toMatchObject({ url: expect.any(URL) });
    expect(inspectUrl('http://example.com')).toMatchObject({ url: expect.any(URL) });
    for (const bad of [
      'file:///etc/passwd',
      'ftp://h/x',
      'gopher://h',
      'data:text/html,x',
      'notaurl',
    ]) {
      expect(inspectUrl(bad)).toHaveProperty('error');
    }
  });
});

describe('ssrf-guard / isBlockedIp', () => {
  it('blocks every private/internal range (IPv4 + IPv6)', () => {
    for (const ip of [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '169.254.0.1',
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      '::ffff:127.0.0.1', // IPv4-mapped loopback
      '::ffff:10.0.0.1',
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:2800:220:1::1']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it('fails closed on malformed input', () => {
    for (const bad of ['', 'not-an-ip', '999.1.1.1', '10.0.0']) {
      expect(isBlockedIp(bad), bad).toBe(true);
    }
  });
});

describe('ssrf-guard / isBlockedHostname', () => {
  it('blocks internal names and obfuscated IP encodings', () => {
    for (const host of [
      'localhost',
      'foo.localhost',
      'db.internal',
      'printer.local',
      'metadata.google.internal',
      'metadata',
      '2130706433', // decimal 127.0.0.1
      '0x7f000001', // hex 127.0.0.1
      '0177.0.0.1', // octal
    ]) {
      expect(isBlockedHostname(host), host).toBe(true);
    }
  });

  it('allows normal public hostnames', () => {
    for (const host of [
      'example.com',
      'developer.mozilla.org',
      'api.github.com',
      'sub.domain.co',
    ]) {
      expect(isBlockedHostname(host), host).toBe(false);
    }
  });
});
