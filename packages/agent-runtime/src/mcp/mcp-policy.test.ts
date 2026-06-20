import { describe, expect, it } from 'vitest';
import { allowedForRole, toolAccessFor } from './mcp-policy';
import type { McpTool } from './mcp-client';

const tool = (name: string, annotations?: McpTool['annotations']): McpTool => ({
  name,
  inputSchema: {},
  ...(annotations !== undefined ? { annotations } : {}),
});

describe('toolAccessFor', () => {
  it('treats an unclassified tool as mutating (safe default)', () => {
    expect(toolAccessFor(tool('do'))).toBe('mutate');
  });
  it('uses readOnlyHint / destructiveHint', () => {
    expect(toolAccessFor(tool('read', { readOnlyHint: true }))).toBe('read');
    expect(toolAccessFor(tool('wipe', { destructiveHint: true }))).toBe('mutate');
  });
  it('config overrides the server hint', () => {
    expect(toolAccessFor(tool('x', { destructiveHint: true }), { readOnlyTools: ['x'] })).toBe(
      'read',
    );
    expect(toolAccessFor(tool('y', { readOnlyHint: true }), { mutatingTools: ['y'] })).toBe(
      'mutate',
    );
  });
});

describe('allowedForRole', () => {
  it('acting roles get every tool', () => {
    expect(allowedForRole('mutate', false, true)).toBe(true);
    expect(allowedForRole('read', false, true)).toBe(true);
  });
  it('read-only roles get only read tools', () => {
    expect(allowedForRole('read', true, true)).toBe(true);
    expect(allowedForRole('mutate', true, true)).toBe(false);
  });
  it('allowReadOnlyRoles=false hides the server from read-only roles entirely', () => {
    expect(allowedForRole('read', true, false)).toBe(false);
  });
});
