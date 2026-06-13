import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigValidationError } from '@excalibur/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PROVIDERS_CONFIG,
  loadProvidersFile,
  providersFileSchema,
  resolveApiKey,
} from './providers-file';

const tempDir = mkdtempSync(join(tmpdir(), 'excalibur-model-gateway-'));
let fileCounter = 0;

function writeProvidersYaml(content: string): string {
  fileCounter += 1;
  const filePath = join(tempDir, `providers-${fileCounter}.yaml`);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// The verbatim example from oss-spec §14.
const OSS_SPEC_EXAMPLE = `
providers:
  default: qwen
  qwen:
    type: openai-compatible
    baseUrl: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
    apiKeyEnv: QWEN_API_KEY
  deepseek:
    type: openai-compatible
    baseUrl: https://api.deepseek.com/v1
    apiKeyEnv: DEEPSEEK_API_KEY
  ollama:
    type: ollama
    baseUrl: http://localhost:11434
`;

describe('DEFAULT_PROVIDERS_CONFIG', () => {
  it('is a single mock provider set as default', () => {
    const section: { default?: string } = DEFAULT_PROVIDERS_CONFIG.providers;
    expect(section.default).toBe('mock');
    const names = Object.keys(DEFAULT_PROVIDERS_CONFIG.providers).filter((k) => k !== 'default');
    expect(names).toEqual(['mock']);
  });

  it('validates against providersFileSchema', () => {
    const result = providersFileSchema.safeParse(DEFAULT_PROVIDERS_CONFIG);
    expect(result.success).toBe(true);
  });
});

describe('loadProvidersFile', () => {
  it('parses the oss-spec §14 example', () => {
    const config = loadProvidersFile(writeProvidersYaml(OSS_SPEC_EXAMPLE));
    const section: { default?: string } = config.providers;
    expect(section.default).toBe('qwen');
    const providers: Record<string, { type: string; baseUrl?: string; apiKeyEnv?: string }> =
      config.providers;
    expect(providers['qwen']?.type).toBe('openai-compatible');
    expect(providers['qwen']?.apiKeyEnv).toBe('QWEN_API_KEY');
    expect(providers['ollama']?.type).toBe('ollama');
    expect(providers['ollama']?.baseUrl).toBe('http://localhost:11434');
  });

  it('parses cost metadata fields', () => {
    const config = loadProvidersFile(
      writeProvidersYaml(`
providers:
  default: paid
  paid:
    type: openai-compatible
    baseUrl: https://api.example.com/v1
    apiKeyEnv: PAID_API_KEY
    model: paid-large
    inputCostPerMillionTokensCents: 300
    outputCostPerMillionTokensCents: 1500
`),
    );
    const providers: Record<string, { inputCostPerMillionTokensCents?: number }> =
      config.providers;
    expect(providers['paid']?.inputCostPerMillionTokensCents).toBe(300);
  });

  it('rejects an unknown provider type with a readable path', () => {
    const filePath = writeProvidersYaml(`
providers:
  default: weird
  weird:
    type: telepathy
`);
    expect(() => loadProvidersFile(filePath)).toThrowError(ConfigValidationError);
    try {
      loadProvidersFile(filePath);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      if (error instanceof ConfigValidationError) {
        expect(error.code).toBe('config_validation');
        expect(error.message).toContain('providers.weird.type');
      }
    }
  });

  it('rejects a default pointing at a provider that is not configured', () => {
    const filePath = writeProvidersYaml(`
providers:
  default: missing
  mock:
    type: mock
`);
    expect(() => loadProvidersFile(filePath)).toThrowError(ConfigValidationError);
    expect(() => loadProvidersFile(filePath)).toThrowError(/missing/);
  });

  it('rejects a providers file with no providers', () => {
    expect(() => loadProvidersFile(writeProvidersYaml('providers: {}\n'))).toThrowError(
      ConfigValidationError,
    );
  });

  it('rejects negative cost values', () => {
    const filePath = writeProvidersYaml(`
providers:
  mock:
    type: mock
    inputCostPerMillionTokensCents: -5
`);
    expect(() => loadProvidersFile(filePath)).toThrowError(ConfigValidationError);
  });

  it('throws ConfigValidationError for malformed YAML', () => {
    const filePath = writeProvidersYaml('providers:\n  default: [unclosed\n');
    expect(() => loadProvidersFile(filePath)).toThrowError(ConfigValidationError);
    expect(() => loadProvidersFile(filePath)).toThrowError(/not valid YAML/);
  });

  it('throws ConfigValidationError for a non-mapping document', () => {
    expect(() => loadProvidersFile(writeProvidersYaml('- just\n- a list\n'))).toThrowError(
      ConfigValidationError,
    );
  });

  it('throws ConfigValidationError when the file does not exist', () => {
    expect(() => loadProvidersFile(join(tempDir, 'nope.yaml'))).toThrowError(
      ConfigValidationError,
    );
    expect(() => loadProvidersFile(join(tempDir, 'nope.yaml'))).toThrowError(/Cannot read/);
  });
});

describe('resolveApiKey', () => {
  const ENV_VAR = 'EXCALIBUR_TEST_PROVIDER_KEY';

  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  it('reads the key from the named environment variable', () => {
    process.env[ENV_VAR] = 'test-key-value';
    expect(resolveApiKey({ apiKeyEnv: ENV_VAR })).toBe('test-key-value');
  });

  it('returns null when the variable is unset', () => {
    expect(resolveApiKey({ apiKeyEnv: ENV_VAR })).toBeNull();
  });

  it('returns null when the variable is set but empty', () => {
    process.env[ENV_VAR] = '';
    expect(resolveApiKey({ apiKeyEnv: ENV_VAR })).toBeNull();
  });

  it('returns null when no apiKeyEnv is configured', () => {
    expect(resolveApiKey({})).toBeNull();
  });
});
