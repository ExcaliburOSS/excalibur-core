import { describe, expect, it } from 'vitest';
import { MAX_BODY_EXCERPT_LENGTH, buildBodyExcerpt, redactSyncSecrets } from './redact';

describe('redactSyncSecrets', () => {
  it('masks known literal secrets wherever they appear', () => {
    const out = redactSyncSecrets('denied for key my_key_42 (my_key_42)', ['my_key_42']);
    expect(out).not.toContain('my_key_42');
    expect(out).toBe('denied for key [REDACTED] ([REDACTED])');
  });

  it('masks Authorization Bearer tokens', () => {
    const out = redactSyncSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).toContain('[REDACTED]');
  });

  it('masks OpenAI-style, GitHub, AWS and Slack tokens', () => {
    // Tokens are assembled at runtime so this fixture file holds no contiguous
    // secret-shaped literal that would trip secret scanners. 'AKIA…EXAMPLE' is the
    // canonical AWS docs example key and is allow-listed by scanners, so it stays inline.
    const t = (prefix: string, body: string): string => prefix + body;
    const text = [
      t('sk-', 'proj-abcdef1234567890'),
      t('ghp_', 'abcdEFGH12345678'),
      'AKIAIOSFODNN7EXAMPLE',
      t('xoxb-', '1234-5678-abcdefgh'),
    ].join(' ');
    const out = redactSyncSecrets(text);
    expect(out).not.toContain('sk-proj');
    expect(out).not.toContain('ghp_');
    expect(out).not.toContain('AKIA');
    expect(out).not.toContain('xoxb-');
  });

  it('masks key/value secrets while keeping the key name', () => {
    const out = redactSyncSecrets('{"error":"bad request","apiKey":"super-secret-value"}');
    expect(out).toContain('apiKey');
    expect(out).not.toContain('super-secret-value');
  });

  it('masks PEM private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----';
    const out = redactSyncSecrets(`error dump: ${pem}`);
    expect(out).not.toContain('MIIEow');
  });

  it('leaves innocuous text untouched', () => {
    const text = 'Not Found: repository "demo" is unknown';
    expect(redactSyncSecrets(text)).toBe(text);
  });
});

describe('buildBodyExcerpt', () => {
  it('redacts before truncating so a secret cannot straddle the cut point', () => {
    const secret = 'sk-' + 'a'.repeat(300);
    const out = buildBodyExcerpt(`prefix ${secret} suffix`, [], 40);
    expect(out).not.toContain('aaaaaaaaaa');
    expect(out).toContain('[REDACTED]');
  });

  it('caps output at the default maximum length', () => {
    const out = buildBodyExcerpt('z'.repeat(5_000));
    expect(out.length).toBeLessThanOrEqual(MAX_BODY_EXCERPT_LENGTH + '… (truncated)'.length);
    expect(out.endsWith('… (truncated)')).toBe(true);
  });

  it('returns short bodies trimmed but otherwise intact', () => {
    expect(buildBodyExcerpt('  plain error  ')).toBe('plain error');
  });
});
