import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCustomAgents, parseAgentFile, resolveCustomAgent } from './custom-agents';

/** P1.7 — self-contained custom agents loader + front-matter parsing. */

describe('parseAgentFile', () => {
  it('parses full front matter + body as the system prompt', () => {
    const agent = parseAgentFile(
      'sec-reviewer',
      [
        '---',
        'name: Security Reviewer',
        'description: Adversarial security review',
        'role: security',
        'model: kimi-k2.7-code',
        'provider: kimi',
        'temperature: 0.1',
        'tools: [read_file, search_code, git_diff]',
        'permissions:',
        '  tools: { write_file: false }',
        "  deniedCommands: ['git push*']",
        '---',
        '',
        'You are a meticulous security reviewer. Hunt for injection.',
      ].join('\n'),
    );
    expect(agent).not.toBeNull();
    expect(agent?.name).toBe('sec-reviewer');
    expect(agent?.displayName).toBe('Security Reviewer');
    expect(agent?.description).toBe('Adversarial security review');
    expect(agent?.role).toBe('security');
    expect(agent?.model).toBe('kimi-k2.7-code');
    expect(agent?.provider).toBe('kimi');
    expect(agent?.temperature).toBe(0.1);
    expect(agent?.tools).toEqual(['read_file', 'search_code', 'git_diff']);
    expect(agent?.permissions?.tools?.['write_file']).toBe(false);
    expect(agent?.permissions?.deniedCommands).toEqual(['git push*']);
    expect(agent?.systemPrompt).toContain('meticulous security reviewer');
  });

  it('defaults displayName (humanized) + description (first body line) without front matter', () => {
    const agent = parseAgentFile('my-helper', '# Refactor helper\n\nRewrites code cleanly.');
    expect(agent?.displayName).toBe('My Helper');
    expect(agent?.description).toBe('Refactor helper');
    expect(agent?.systemPrompt).toContain('Rewrites code cleanly.');
    expect(agent?.role).toBeUndefined();
  });

  it('returns null on an empty body (an agent needs a prompt)', () => {
    expect(parseAgentFile('empty', '---\nname: X\n---\n')).toBeNull();
  });

  it('returns null on invalid front matter (refuse rather than misconfigure)', () => {
    // `temperature` out of range and `role` not in the enum → reject.
    const bad = parseAgentFile('bad', '---\nrole: wizard\ntemperature: 9\n---\nbody');
    expect(bad).toBeNull();
  });
});

describe('loadCustomAgents', () => {
  let root: string;
  let home: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'exc-agents-'));
    home = mkdtempSync(join(tmpdir(), 'exc-home-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function writeAgent(dir: string, file: string, content: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), content, 'utf8');
  }

  it('loads project agents from .excalibur/agents', () => {
    writeAgent(join(root, '.excalibur', 'agents'), 'planner.md', 'You plan carefully.');
    const agents = loadCustomAgents({ repoRoot: root });
    expect(agents.has('planner')).toBe(true);
    expect(agents.get('planner')?.source).toBe('project');
  });

  it('project agents override global ones on a name clash', () => {
    writeAgent(
      join(home, '.config', 'excalibur', 'agents'),
      'rev.md',
      '---\ndescription: global\n---\nGlobal reviewer.',
    );
    writeAgent(
      join(root, '.excalibur', 'agents'),
      'rev.md',
      '---\ndescription: project\n---\nProject reviewer.',
    );
    const agents = loadCustomAgents({ repoRoot: root, homeDir: home, includeGlobal: true });
    expect(agents.get('rev')?.description).toBe('project');
    expect(agents.get('rev')?.source).toBe('project');
  });

  it('ignores the global dir unless includeGlobal is set', () => {
    writeAgent(join(home, '.config', 'excalibur', 'agents'), 'g.md', 'Global only.');
    expect(loadCustomAgents({ repoRoot: root, homeDir: home }).has('g')).toBe(false);
    expect(resolveCustomAgent('g', { repoRoot: root, homeDir: home })?.name).toBe('g');
  });

  it('skips files with invalid front matter', () => {
    writeAgent(join(root, '.excalibur', 'agents'), 'ok.md', 'fine');
    writeAgent(join(root, '.excalibur', 'agents'), 'bad.md', '---\nrole: nope\n---\nbody');
    const agents = loadCustomAgents({ repoRoot: root });
    expect(agents.has('ok')).toBe(true);
    expect(agents.has('bad')).toBe(false);
  });
});
