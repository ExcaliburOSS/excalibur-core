import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandCustomCommand, loadCustomCommands } from './custom-commands';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'custom-cmd-'));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function writeCommand(rel: string, content: string): void {
  const dir = join(repo, '.excalibur', 'commands');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, rel), content, 'utf8');
}

describe('loadCustomCommands', () => {
  it('loads project commands with front-matter description', () => {
    writeCommand(
      'review.md',
      '---\ndescription: Review the diff\n---\nReview $ARGUMENTS carefully.',
    );
    const cmds = loadCustomCommands({ repoRoot: repo });
    const review = cmds.get('review');
    expect(review?.description).toBe('Review the diff');
    expect(review?.body).toBe('Review $ARGUMENTS carefully.');
    expect(review?.source).toBe('project');
  });

  it('falls back to the first body line for the description', () => {
    writeCommand('quick.md', '# Quick fix\nDo $1 now.');
    expect(loadCustomCommands({ repoRoot: repo }).get('quick')?.description).toBe('Quick fix');
  });

  it('project commands override user-global on a name clash', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    try {
      const gdir = join(home, '.config', 'excalibur', 'commands');
      mkdirSync(gdir, { recursive: true });
      writeFileSync(join(gdir, 'dup.md'), 'GLOBAL body', 'utf8');
      writeCommand('dup.md', 'PROJECT body');
      const cmds = loadCustomCommands({ repoRoot: repo, homeDir: home, includeGlobal: true });
      expect(cmds.get('dup')?.body).toBe('PROJECT body');
      expect(cmds.get('dup')?.source).toBe('project');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('ignores the user-global dir unless includeGlobal is set', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    try {
      const gdir = join(home, '.config', 'excalibur', 'commands');
      mkdirSync(gdir, { recursive: true });
      writeFileSync(join(gdir, 'g.md'), 'global', 'utf8');
      expect(loadCustomCommands({ repoRoot: repo, homeDir: home }).has('g')).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('expandCustomCommand', () => {
  it('expands $ARGUMENTS and positional $1/$2', async () => {
    const out = await expandCustomCommand('Fix $1 in $2 — full: $ARGUMENTS', {
      argv: ['theBug', 'src/app.ts'],
      repoRoot: repo,
    });
    expect(out).toBe('Fix theBug in src/app.ts — full: theBug src/app.ts');
  });

  it('inlines @file contents (repo-confined)', async () => {
    writeFileSync(join(repo, 'note.txt'), 'HELLO', 'utf8');
    const out = await expandCustomCommand('Context: @note.txt', { argv: [], repoRoot: repo });
    expect(out).toBe('Context: HELLO');
  });

  it('leaves an unreadable @token and a traversal token literal', async () => {
    const out = await expandCustomCommand('@nope.txt and @../escape', { argv: [], repoRoot: repo });
    expect(out).toBe('@nope.txt and @../escape');
  });

  it('substitutes !`cmd` with the injected exec output', async () => {
    const out = await expandCustomCommand('branch: !`git branch`', {
      argv: [],
      repoRoot: repo,
      exec: (cmd) => Promise.resolve(cmd === 'git branch' ? '  main\n' : ''),
    });
    expect(out).toBe('branch: main');
  });

  it('reports a failed command inline (never throws)', async () => {
    const out = await expandCustomCommand('x !`bad`', {
      argv: [],
      repoRoot: repo,
      exec: () => Promise.reject(new Error('boom')),
    });
    expect(out).toMatch(/command failed: boom/);
  });

  it('resolves @$1 (an arg-driven file path)', async () => {
    writeFileSync(join(repo, 'a.txt'), 'AAA', 'utf8');
    const out = await expandCustomCommand('see @$1', { argv: ['a.txt'], repoRoot: repo });
    expect(out).toBe('see AAA');
  });
});
