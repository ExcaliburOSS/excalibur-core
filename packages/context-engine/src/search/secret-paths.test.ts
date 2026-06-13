import { describe, expect, it } from 'vitest';
import { isSecretPath } from './secret-paths';

describe('isSecretPath', () => {
  it.each([
    'src/auth/login.ts',
    'src/billing/invoice.ts',
    'src/token.service.ts',
    'src/services/auth.ts',
    'config.json',
    'src/config/app.config.ts',
    'README.md',
    'packages/core/src/index.ts',
  ])('treats ordinary application code/config as non-secret: %s', (path) => {
    expect(isSecretPath(path)).toBe(false);
  });

  it.each([
    '.env',
    '.env.local',
    '.env.production',
    'config/.env.test',
    'secrets/api.json',
    'src/credentials/aws.json',
    'deploy/.npmrc',
    '.netrc',
    'infra/.aws/credentials',
    'k8s/.kube/config',
    'docker/.docker/config.json',
    'keys/id_rsa',
    'keys/id_ed25519',
    'certs/server.pem',
    'tls/private.key',
    '.git-credentials',
    '.pypirc',
    '.htpasswd',
  ])('excludes credential-bearing path from retrieval: %s', (path) => {
    expect(isSecretPath(path)).toBe(true);
  });
});
