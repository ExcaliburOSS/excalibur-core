import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigValidationError, isExcaliburError } from '@excalibur/shared';
import {
  CREDENTIALS_FILE_MODE,
  CREDENTIALS_RELATIVE_PATH,
  getCredentialsFilePath,
  loadCliCredentials,
  saveCliCredentials,
} from './credentials';

const POSIX = process.platform !== 'win32';

describe('credentials', () => {
  let baseDir: string;
  /** Empty env stub so the developer's real EXCALIBUR_* vars cannot leak in. */
  const noEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'excalibur-credentials-'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  describe('getCredentialsFilePath', () => {
    it('resolves under the injected base directory', () => {
      expect(getCredentialsFilePath(baseDir)).toBe(path.join(baseDir, CREDENTIALS_RELATIVE_PATH));
    });

    it('defaults to the home directory at ~/.config/excalibur/credentials.json', () => {
      expect(getCredentialsFilePath()).toBe(
        path.join(os.homedir(), '.config', 'excalibur', 'credentials.json'),
      );
    });
  });

  describe('round trip', () => {
    it('saves and loads credentials through a temp base directory', () => {
      const credentials = { baseUrl: 'https://enterprise.example.com', apiKey: 'exc_test_key_123' };
      const writtenPath = saveCliCredentials(credentials, { baseDir });

      expect(writtenPath).toBe(path.join(baseDir, '.config', 'excalibur', 'credentials.json'));
      expect(fs.existsSync(writtenPath)).toBe(true);

      const loaded = loadCliCredentials({ baseDir, env: noEnv });
      expect(loaded).toEqual(credentials);
    });

    it('writes the file with mode 0600', () => {
      if (!POSIX) {
        return; // POSIX file modes are not meaningful on Windows.
      }
      const writtenPath = saveCliCredentials(
        { baseUrl: 'https://enterprise.example.com', apiKey: 'k' },
        { baseDir },
      );
      const mode = fs.statSync(writtenPath).mode & 0o777;
      expect(mode).toBe(CREDENTIALS_FILE_MODE);
    });

    it('re-tightens mode to 0600 when overwriting a file with looser permissions', () => {
      if (!POSIX) {
        return;
      }
      const writtenPath = saveCliCredentials(
        { baseUrl: 'https://enterprise.example.com', apiKey: 'k1' },
        { baseDir },
      );
      fs.chmodSync(writtenPath, 0o644);

      saveCliCredentials({ baseUrl: 'https://enterprise.example.com', apiKey: 'k2' }, { baseDir });
      expect(fs.statSync(writtenPath).mode & 0o777).toBe(CREDENTIALS_FILE_MODE);
    });

    it('persists pretty-printed JSON containing only the two credential fields', () => {
      const writtenPath = saveCliCredentials(
        { baseUrl: 'https://enterprise.example.com', apiKey: 'exc_key' },
        { baseDir },
      );
      const parsed: unknown = JSON.parse(fs.readFileSync(writtenPath, 'utf8'));
      expect(parsed).toEqual({ baseUrl: 'https://enterprise.example.com', apiKey: 'exc_key' });
    });
  });

  describe('saveCliCredentials validation', () => {
    it('rejects an empty apiKey with ConfigValidationError', () => {
      expect(() => saveCliCredentials({ baseUrl: 'https://x.example', apiKey: '  ' }, { baseDir })).toThrow(
        ConfigValidationError,
      );
    });

    it('rejects a non-URL baseUrl with ConfigValidationError', () => {
      expect(() => saveCliCredentials({ baseUrl: 'not a url', apiKey: 'k' }, { baseDir })).toThrow(
        ConfigValidationError,
      );
    });
  });

  describe('loadCliCredentials', () => {
    it('returns null when neither file nor env vars are present', () => {
      expect(loadCliCredentials({ baseDir, env: noEnv })).toBeNull();
    });

    it('prefers both env vars over the stored file', () => {
      saveCliCredentials({ baseUrl: 'https://file.example.com', apiKey: 'file_key' }, { baseDir });

      const loaded = loadCliCredentials({
        baseDir,
        env: {
          EXCALIBUR_BASE_URL: 'https://env.example.com',
          EXCALIBUR_API_KEY: 'env_key',
        },
      });
      expect(loaded).toEqual({ baseUrl: 'https://env.example.com', apiKey: 'env_key' });
    });

    it('merges a single env var over the file (per-field precedence)', () => {
      saveCliCredentials({ baseUrl: 'https://file.example.com', apiKey: 'file_key' }, { baseDir });

      const loaded = loadCliCredentials({ baseDir, env: { EXCALIBUR_API_KEY: 'env_key' } });
      expect(loaded).toEqual({ baseUrl: 'https://file.example.com', apiKey: 'env_key' });
    });

    it('resolves from env vars alone when no file exists', () => {
      const loaded = loadCliCredentials({
        baseDir,
        env: {
          EXCALIBUR_BASE_URL: 'https://env-only.example.com',
          EXCALIBUR_API_KEY: 'env_only_key',
        },
      });
      expect(loaded).toEqual({ baseUrl: 'https://env-only.example.com', apiKey: 'env_only_key' });
    });

    it('ignores empty/whitespace env values', () => {
      saveCliCredentials({ baseUrl: 'https://file.example.com', apiKey: 'file_key' }, { baseDir });

      const loaded = loadCliCredentials({
        baseDir,
        env: { EXCALIBUR_BASE_URL: '  ', EXCALIBUR_API_KEY: '' },
      });
      expect(loaded).toEqual({ baseUrl: 'https://file.example.com', apiKey: 'file_key' });
    });

    it('returns null when only one field can be resolved', () => {
      expect(loadCliCredentials({ baseDir, env: { EXCALIBUR_API_KEY: 'lonely_key' } })).toBeNull();
    });

    it('does not read a corrupted file when both env vars are set', () => {
      const filePath = getCredentialsFilePath(baseDir);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '{not json');

      const loaded = loadCliCredentials({
        baseDir,
        env: { EXCALIBUR_BASE_URL: 'https://env.example.com', EXCALIBUR_API_KEY: 'env_key' },
      });
      expect(loaded).toEqual({ baseUrl: 'https://env.example.com', apiKey: 'env_key' });
    });

    it('throws ConfigValidationError for a malformed JSON file', () => {
      const filePath = getCredentialsFilePath(baseDir);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '{not json');

      try {
        loadCliCredentials({ baseDir, env: noEnv });
        expect.unreachable('expected loadCliCredentials to throw');
      } catch (error) {
        expect(isExcaliburError(error)).toBe(true);
        expect(error).toBeInstanceOf(ConfigValidationError);
        expect((error as ConfigValidationError).code).toBe('config_validation');
        // The error must reference the path but never the file content.
        expect((error as ConfigValidationError).message).toContain(filePath);
        expect((error as ConfigValidationError).message).not.toContain('not json');
      }
    });

    it('throws ConfigValidationError for a file with wrong field types', () => {
      const filePath = getCredentialsFilePath(baseDir);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ baseUrl: 42, apiKey: ['nope'] }));

      expect(() => loadCliCredentials({ baseDir, env: noEnv })).toThrow(ConfigValidationError);
    });

    it('throws ConfigValidationError when env vars resolve to an invalid pair', () => {
      expect(() =>
        loadCliCredentials({
          baseDir,
          env: { EXCALIBUR_BASE_URL: 'not-a-url', EXCALIBUR_API_KEY: 'k' },
        }),
      ).toThrow(ConfigValidationError);
    });
  });
});
