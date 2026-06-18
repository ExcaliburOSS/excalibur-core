import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redaction';

/**
 * Build a provider-shaped token at runtime from its prefix and body. The runtime
 * value is identical to a real-looking token (so the redaction patterns under
 * test still match), but the literal never appears contiguously in this source
 * file — which keeps secret scanners (e.g. GitHub push protection) from flagging
 * these intentionally-fake fixtures.
 */
const token = (prefix: string, body: string): string => prefix + body;

describe('redactSecrets', () => {
  it('redacts classic OpenAI-style sk- keys', () => {
    const text = `export OPENAI_API_KEY=${token('sk-', 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90Uv12Wx34')}`;
    const redacted = redactSecrets(text);
    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain('sk-Ab12');
    // The env var NAME stays readable; only the value is masked.
    expect(redacted).toContain('export OPENAI_API_KEY=');
  });

  it('redacts project-scoped and Anthropic-style sk- keys', () => {
    const text = [
      `openai: ${token('sk-', 'proj-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd')}`,
      `anthropic: ${token('sk-', 'ant-api03-Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe-DcBa98765')}`,
    ].join('\n');
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain('sk-proj-');
    expect(redacted).not.toContain('sk-ant-');
    expect(redacted.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('redacts AWS access key ids', () => {
    const text = 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE in ~/.aws/credentials';
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(redacted).toContain('[REDACTED]');
  });

  it.each([
    ['ghp_', token('ghp_', '16C7e42F292c6912E7710c838347Ae178B4a')],
    ['gho_', token('gho_', '8Fk2mZx91LpQr3St5Uv7Wy9Za1Bc3De5Fg7H')],
    ['ghs_', token('ghs_', '1Ab2Cd3Ef4Gh5Ij6Kl7Mn8Op9Qr0St1Uv2Wx')],
  ])('redacts GitHub %s tokens', (_prefix, ghToken) => {
    const redacted = redactSecrets(`git clone https://x:${ghToken}@github.com/org/repo.git`);
    expect(redacted).not.toContain(ghToken);
    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts GitHub fine-grained github_pat_ tokens', () => {
    const pat = token('github_pat_', '11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUV');
    const redacted = redactSecrets(`token: ${pat}`);
    expect(redacted).not.toContain('github_pat_11');
  });

  it.each([
    ['bot', token('xoxb-', '1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx')],
    ['user', token('xoxp-', '9876543210-9876543210987-1234567890123-aabbccddeeff00112233445566778899')],
  ])('redacts Slack %s tokens', (_kind, slackToken) => {
    const redacted = redactSecrets(`SLACK_TOKEN=${slackToken}`);
    expect(redacted).not.toContain(slackToken);
    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts entire PEM private key blocks, including header and footer', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL',
      'MNOPQRSTUVWXYZ+/0123456789abcdefghijklmnopqrstuvwxyzABCDEF==',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const redacted = redactSecrets(`Found this in the repo:\n${pem}\nPlease rotate it.`);
    expect(redacted).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(redacted).not.toContain('MIIEowIBAAKCAQEA');
    expect(redacted).toContain('Found this in the repo:\n[REDACTED]\nPlease rotate it.');
  });

  it('redacts OPENSSH and unlabeled private key blocks', () => {
    const openssh = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';
    const plain = '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEG\n-----END PRIVATE KEY-----';
    const redacted = redactSecrets(`${openssh}\n\n${plain}`);
    expect(redacted).not.toContain('PRIVATE KEY');
    expect(redacted.match(/\[REDACTED\]/g)?.length).toBe(2);
  });

  it('redacts Authorization: Bearer headers while keeping the header name', () => {
    const text = 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.dQw4w9WgXcQ" https://api.example.com';
    const redacted = redactSecrets(text);
    expect(redacted).toContain('Authorization: Bearer [REDACTED]');
    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiI');
  });

  it('is case-insensitive for the authorization header', () => {
    const redacted = redactSecrets('authorization: bearer abc123def456ghi789');
    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain('abc123def456ghi789');
  });

  it('redacts password=… values in env lines and URLs', () => {
    const redacted = redactSecrets(
      'DATABASE_URL=postgres://app:hunter2@db:5432/prod?password=hunter2&sslmode=require',
    );
    expect(redacted).not.toContain('password=hunter2');
    expect(redacted).toContain('password=[REDACTED]');
    // The rest of the URL structure survives.
    expect(redacted).toContain('&sslmode=require');
  });

  it('redacts apiKey: … values in YAML', () => {
    const redacted = redactSecrets('integrations:\n  linear:\n    apiKey: lin_api_0123456789abcdef\n');
    expect(redacted).toContain('apiKey: [REDACTED]');
    expect(redacted).not.toContain('lin_api_0123456789abcdef');
  });

  it('redacts quoted "api_key" values in JSON', () => {
    const redacted = redactSecrets('{ "api_key": "9f8e7d6c5b4a3210", "region": "eu-west-1" }');
    expect(redacted).toContain('"api_key": "[REDACTED]"');
    expect(redacted).toContain('"region": "eu-west-1"');
  });

  it('redacts secret/token-style assignments', () => {
    const redacted = redactSecrets(
      'client_secret=Zx9Yw8Vu7t\naccess_token: ya29.a0AfH6SMBx\nrefresh-token = 1//0gabcdefgh',
    );
    expect(redacted).not.toContain('Zx9Yw8Vu7t');
    expect(redacted).not.toContain('ya29.a0AfH6SMBx');
    expect(redacted).not.toContain('1//0gabcdefgh');
    expect(redacted.match(/\[REDACTED\]/g)?.length).toBe(3);
  });

  it('redacts npm automation tokens (npm_…)', () => {
    const npmTok = token('npm_', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab');
    const redacted = redactSecrets(`//registry.npmjs.org/:_authToken=${npmTok}`);
    expect(redacted).not.toContain(npmTok);
    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts .npmrc _auth/_authToken/_password assignments (often base64)', () => {
    const b64 = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5';
    const redacted = redactSecrets(
      [
        `_auth=${b64}`,
        '//registry.example.com/:_authToken=opaque-registry-token-value',
        `_password=${b64}`,
      ].join('\n'),
    );
    expect(redacted).not.toContain(b64);
    expect(redacted).not.toContain('opaque-registry-token-value');
    expect(redacted).toContain('_auth=[REDACTED]');
    expect(redacted).toContain('_authToken=[REDACTED]');
    expect(redacted).toContain('_password=[REDACTED]');
  });

  it('redacts standalone Google OAuth ya29.* tokens', () => {
    const ya = token('ya29.', 'a0AfH6SMBxAbCdEfGhIjKlMnOpQrStUvWxYz');
    const redacted = redactSecrets(`Cached token ${ya} in memory.`);
    expect(redacted).not.toContain(ya);
    expect(redacted).toContain('Cached token [REDACTED] in memory.');
  });

  it('redacts JSON Web Tokens (eyJ.eyJ.sig)', () => {
    const jwt = `${token('eyJ', 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')}.${token('eyJ', 'zdWIiOiJ1c2VyLTQyIiwibmFtZSI6IkFkYSJ9')}.S0meHardT0GuessSignatureValue_-123`;
    const redacted = redactSecrets(`{"id_token":"${jwt}"}`);
    expect(redacted).not.toContain(jwt);
    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts Stripe secret/restricted keys (underscore form)', () => {
    const live = token('sk_live_', '4eC39HqLyjWDarjtT1zdp7dcABCDEFGH');
    const restricted = token('rk_live_', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ012345');
    const redacted = redactSecrets(`STRIPE_SECRET_KEY=${live}\nSTRIPE_RESTRICTED=${restricted}`);
    expect(redacted).not.toContain(live);
    expect(redacted).not.toContain(restricted);
    expect(redacted.match(/\[REDACTED\]/g)?.length).toBe(2);
  });

  it('does NOT redact short Stripe publishable pk_ keys (they are public)', () => {
    // Short + low-entropy so neither the Stripe pattern (scoped to sk_/rk_)
    // nor the high-entropy fallback fires — proving publishable keys survive.
    const pub = token('pk_live_', 'examplekey00');
    const redacted = redactSecrets(`pub: ${pub}`);
    expect(redacted).toContain(pub);
  });

  it('redacts the password in a connection-string userinfo, keeping scheme+user', () => {
    const redacted = redactSecrets('redis://default:Sup3rS3cretP4ss@cache.internal:6379/0');
    expect(redacted).not.toContain('Sup3rS3cretP4ss');
    expect(redacted).toContain('redis://default:[REDACTED]@cache.internal:6379/0');
  });

  it('redacts a high-entropy opaque token with no keyword context', () => {
    // 48 chars, mixed case + digits, random — looks like an API token.
    const secret = 'Xq3Tz9Lm2Pw7Rk5Bn8Vc1Df4Gh6Js0Ya2Ue9Io3Pa5Sd7Fk';
    const redacted = redactSecrets(`The value is ${secret} use it carefully.`);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain('The value is [REDACTED] use it carefully.');
  });

  it('does NOT redact a 40-char lowercase git SHA-like string', () => {
    // git object ids are lowercase hex — no uppercase letters → spared.
    const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const redacted = redactSecrets(`Reverted in commit ${sha} yesterday.`);
    expect(redacted).toContain(sha);
  });

  it('does not mask the NAME of an env var, only secret values', () => {
    const redacted = redactSecrets('Set QWEN_API_KEY in your shell before running.');
    expect(redacted).toBe('Set QWEN_API_KEY in your shell before running.');
  });

  it('leaves ordinary text and file paths untouched', () => {
    const text = [
      'A risk-based review of task-scheduler.ts found no issues.',
      'See src/auth/password-reset.controller.ts for the flow.',
      'The xoxo greeting is unrelated to Slack tokens.',
    ].join('\n');
    expect(redactSecrets(text)).toBe(text);
  });
});
