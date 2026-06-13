import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALLOWED_COMMANDS,
  DEFAULT_BLOCKED_PATHS,
  DEFAULT_CONFIG,
  excaliburConfigSchema,
} from './config';

describe('excaliburConfigSchema', () => {
  it('accepts an empty config (every section is optional)', () => {
    const result = excaliburConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts a full config covering every pinned section', () => {
    const result = excaliburConfigSchema.safeParse({
      version: 1,
      project: {
        name: 'quickcontract-api',
        packageManager: 'pnpm',
        languages: ['typescript'],
        frameworks: ['nestjs'],
      },
      commands: { test: 'pnpm test', lint: 'pnpm lint', typecheck: 'pnpm typecheck', build: 'pnpm build' },
      safety: { preset: 'standard-safe' },
      workflowDefaults: { ask: 'ask-repo', run: 'standard-feature' },
      autonomyDefaults: { ask: 1, review: 0, run: 3 },
      autonomy: {
        default: 2,
        paths: { 'src/billing/**': 1, 'src/auth/**': 1 },
        allowFullAgentic: ['src/docs/**', 'src/tests/**'],
      },
      workflows: {
        default: 'standard-feature',
        byTaskType: { bugfix: 'fast-fix' },
        byPath: { 'prisma/migrations/**': 'migration' },
      },
      models: {
        default: 'qwen',
        byRole: { planner: 'qwen', implementer: 'minimax' },
        byPath: { 'src/auth/**': 'local-secure' },
      },
      permissions: {
        tools: { read_file: true, write_file: 'ask', network: false },
        blockedPaths: ['.env', '**/*.pem'],
        allowedCommands: ['npm test'],
      },
      approvals: {
        requiredFor: {
          paths: ['src/billing/**'],
          commands: ['npm run migrate'],
          phases: ['plan', 'before_pr'],
        },
      },
      context: {
        include: ['instructions/general.md', 'README.md'],
        exclude: ['**/.env', '**/node_modules/**'],
      },
      integrations: {
        linear: { apiKeyEnv: 'LINEAR_API_KEY', workspace: 'my-workspace' },
        github: { tokenEnv: 'GITHUB_TOKEN', owner: 'acme', repo: 'quickcontract-api' },
      },
      agents: {
        default: 'native',
        'claude-code': { type: 'custom-command', command: 'claude' },
      },
      instructions: {
        sources: [
          { path: './CLAUDE.md', format: 'claude_md', scope: 'project', enabled: true },
          {
            path: '~/.claude/CLAUDE.md',
            format: 'claude_md',
            scope: 'user_global',
            enabled: true,
            localOnly: true,
          },
        ],
      },
      skills: {
        sources: [
          {
            path: './.claude/skills/testing/SKILL.md',
            scope: 'project',
            enabled: false,
            trustLevel: 'review_required',
          },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents?.default).toBe('native');
      expect(result.data.agents?.['claude-code']).toEqual({
        type: 'custom-command',
        command: 'claude',
      });
    }
  });

  it('normalizes project.commands into the top-level commands section', () => {
    const result = excaliburConfigSchema.parse({
      project: { commands: { test: 'pnpm test', lint: 'pnpm lint' } },
    });
    expect(result.commands).toEqual({ test: 'pnpm test', lint: 'pnpm lint' });
    // The alias remains readable too.
    expect(result.project?.commands).toEqual({ test: 'pnpm test', lint: 'pnpm lint' });
  });

  it('top-level commands win over project.commands on per-key conflicts', () => {
    const result = excaliburConfigSchema.parse({
      commands: { test: 'pnpm test' },
      project: { commands: { test: 'npm test', build: 'npm run build' } },
    });
    expect(result.commands).toEqual({ test: 'pnpm test', build: 'npm run build' });
  });

  it('leaves commands undefined when neither section is present', () => {
    const result = excaliburConfigSchema.parse({ version: 1 });
    expect(result.commands).toBeUndefined();
  });

  it('rejects autonomy levels outside 0..4', () => {
    expect(excaliburConfigSchema.safeParse({ autonomy: { default: 5 } }).success).toBe(false);
    expect(
      excaliburConfigSchema.safeParse({ autonomyDefaults: { run: 7 } }).success,
    ).toBe(false);
    expect(
      excaliburConfigSchema.safeParse({ autonomy: { paths: { 'src/**': 9 } } }).success,
    ).toBe(false);
  });

  it('rejects invalid permission tool values', () => {
    expect(
      excaliburConfigSchema.safeParse({ permissions: { tools: { write_file: 'maybe' } } })
        .success,
    ).toBe(false);
    expect(
      excaliburConfigSchema.safeParse({ permissions: { tools: { write_file: 'ask' } } })
        .success,
    ).toBe(true);
  });

  it('rejects instruction sources with unknown formats or scopes', () => {
    expect(
      excaliburConfigSchema.safeParse({
        instructions: { sources: [{ path: './X.md', format: 'word_doc' }] },
      }).success,
    ).toBe(false);
    expect(
      excaliburConfigSchema.safeParse({
        instructions: { sources: [{ path: './X.md', scope: 'galaxy' }] },
      }).success,
    ).toBe(false);
    expect(
      excaliburConfigSchema.safeParse({ instructions: { sources: [{ path: '' }] } }).success,
    ).toBe(false);
  });

  it('rejects skill sources with invalid trust levels or scopes', () => {
    expect(
      excaliburConfigSchema.safeParse({
        skills: { sources: [{ path: './SKILL.md', trustLevel: 'verified' }] },
      }).success,
    ).toBe(false);
    expect(
      excaliburConfigSchema.safeParse({
        skills: { sources: [{ path: './SKILL.md', scope: 'enterprise' }] },
      }).success,
    ).toBe(false);
  });

  it('rejects non-string integration values and non-record sections', () => {
    expect(
      excaliburConfigSchema.safeParse({ integrations: { linear: { retries: 3 } } }).success,
    ).toBe(false);
    expect(excaliburConfigSchema.safeParse({ workflows: 'standard-feature' }).success).toBe(
      false,
    );
  });

  it('rejects a non-integer version', () => {
    expect(excaliburConfigSchema.safeParse({ version: 1.5 }).success).toBe(false);
  });
});

describe('DEFAULT_BLOCKED_PATHS / DEFAULT_ALLOWED_COMMANDS', () => {
  it('matches the OSS spec §17 blocked path list', () => {
    expect(DEFAULT_BLOCKED_PATHS).toEqual([
      '.env',
      '.env.*',
      '**/*.pem',
      '**/*.key',
      '**/secrets/**',
      '**/.ssh/**',
      'node_modules/**',
      'dist/**',
      'build/**',
    ]);
  });

  it('matches the OSS spec §17 allowed command list', () => {
    expect(DEFAULT_ALLOWED_COMMANDS).toEqual([
      'npm test',
      'npm run test',
      'npm run typecheck',
      'npm run lint',
      'pnpm test',
      'pnpm typecheck',
      'pnpm lint',
      'yarn test',
    ]);
  });
});

describe('DEFAULT_CONFIG', () => {
  it('validates against excaliburConfigSchema', () => {
    const result = excaliburConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
  });

  it('activates the standard-safe preset and onboarding command defaults', () => {
    expect(DEFAULT_CONFIG.safety?.preset).toBe('standard-safe');
    expect(DEFAULT_CONFIG.workflowDefaults).toMatchObject({
      ask: 'ask-repo',
      review: 'review-only',
      patch: 'propose-patch',
      run: 'standard-feature',
      careful: 'structured-feature',
      discovery: 'discovery',
    });
    expect(DEFAULT_CONFIG.autonomyDefaults).toMatchObject({
      ask: 1,
      review: 0,
      patch: 2,
      run: 3,
      careful: 4,
      discovery: 0,
    });
  });

  it('uses safe-by-default permissions (mutating tools ask, network off)', () => {
    const tools = DEFAULT_CONFIG.permissions?.tools ?? {};
    expect(tools['read_file']).toBe(true);
    expect(tools['write_file']).toBe('ask');
    expect(tools['apply_patch']).toBe('ask');
    expect(tools['run_command']).toBe('ask');
    expect(tools['network']).toBe(false);
    expect(DEFAULT_CONFIG.permissions?.blockedPaths).toEqual([...DEFAULT_BLOCKED_PATHS]);
    expect(DEFAULT_CONFIG.permissions?.allowedCommands).toEqual([...DEFAULT_ALLOWED_COMMANDS]);
  });
});
