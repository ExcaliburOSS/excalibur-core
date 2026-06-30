import { describe, expect, it } from 'vitest';
import {
  NATIVE_TOOLS,
  NATIVE_TOOL_NAMES,
  getNativeTool,
  isNativeToolName,
  type NativeToolName,
} from './native-tools';

const PINNED_NAMES: NativeToolName[] = [
  'read_file',
  'write_file',
  'edit',
  'list_files',
  'search_code',
  'run_command',
  'preview',
  'git_diff',
  'apply_patch',
  'create_branch',
  'run_tests',
  'update_tasks',
  'web_fetch',
  'web_search',
  'web_extract',
  'web_crawl',
  'research',
  'lsp',
  'question',
  'skill',
  'project_status',
  'work_items',
  'sprint_status',
  'plans',
  'insights',
  'run_logs',
  'list_agents',
  'list_skills',
  'sessions',
  'verify',
  'review',
  'remember',
  'investigate',
];

describe('NATIVE_TOOLS', () => {
  it('contains exactly the pinned tools, in catalog order', () => {
    expect(NATIVE_TOOLS.map((tool) => tool.name)).toEqual(PINNED_NAMES);
    expect(NATIVE_TOOL_NAMES).toEqual(PINNED_NAMES);
  });

  it('every tool has a non-empty description and a zod parameters schema', () => {
    for (const tool of NATIVE_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(typeof tool.parameters.safeParse).toBe('function');
    }
  });

  it.each([
    ['read_file', { path: 'src/app.ts' }],
    ['write_file', { path: 'src/app.ts', content: 'export {};' }],
    ['list_files', {}],
    ['list_files', { path: 'src', glob: '**/*.ts' }],
    ['search_code', { query: 'releaseEscrow' }],
    ['search_code', { query: 'release', glob: 'src/**', maxResults: 10 }],
    ['run_command', { command: 'npm test' }],
    ['git_diff', {}],
    ['git_diff', { paths: ['src/app.ts'], staged: true }],
    ['apply_patch', { diff: '--- a/x.ts\n+++ b/x.ts' }],
    ['create_branch', { name: 'excalibur/fix-retry' }],
    ['run_tests', {}],
    ['run_tests', { command: 'pnpm test', pattern: 'escrow' }],
    ['lsp', { path: 'src/app.ts', line: 12, column: 5, query: 'definition' }],
    ['lsp', { path: 'src/app.ts', line: 1, column: 1, query: 'hover' }],
    ['question', { question: 'Which database should I target?' }],
    ['question', { question: 'Use REST or gRPC?', context: 'the spec is ambiguous' }],
    ['skill', {}],
    ['skill', { name: 'deploy' }],
  ] as const)('%s accepts valid parameters %j', (name, params) => {
    const tool = getNativeTool(name);
    expect(tool).toBeDefined();
    expect(tool?.parameters.safeParse(params).success).toBe(true);
  });

  it.each([
    ['read_file', {}],
    ['read_file', { path: '' }],
    ['read_file', { path: 'x.ts', extra: true }],
    ['write_file', { path: 'x.ts' }],
    ['search_code', { query: '' }],
    ['search_code', { query: 'x', maxResults: 0 }],
    ['run_command', {}],
    ['run_command', { command: '' }],
    ['git_diff', { paths: 'not-an-array' }],
    ['apply_patch', { diff: '' }],
    ['create_branch', { name: 'has spaces' }],
    ['run_tests', { command: '' }],
    ['lsp', { path: 'x.ts', line: 1, column: 1, query: 'rename' }],
    ['lsp', { path: 'x.ts', line: 0, column: 1, query: 'hover' }],
    ['lsp', { path: 'x.ts', line: 1, column: 1 }],
    ['question', {}],
    ['question', { question: '' }],
    ['question', { question: 'ok', extra: true }],
    ['skill', { name: 5 }],
    ['skill', { other: 'x' }],
  ] as const)('%s rejects invalid parameters %j', (name, params) => {
    const tool = getNativeTool(name);
    expect(tool).toBeDefined();
    expect(tool?.parameters.safeParse(params).success).toBe(false);
  });
});

describe('getNativeTool / isNativeToolName', () => {
  it('finds tools by name and returns undefined for unknown names', () => {
    expect(getNativeTool('read_file')?.name).toBe('read_file');
    expect(getNativeTool('teleport')).toBeUndefined();
  });

  it('narrows native tool names', () => {
    expect(isNativeToolName('apply_patch')).toBe(true);
    expect(isNativeToolName('network')).toBe(false);
    expect(isNativeToolName(42)).toBe(false);
  });
});
