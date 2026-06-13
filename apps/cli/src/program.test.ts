import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { buildProgram, CLI_VERSION } from './program';

function commandNames(program: Command): string[] {
  return program.commands.map((command) => command.name());
}

function subcommandNames(program: Command, name: string): string[] {
  const group = program.commands.find((command) => command.name() === name);
  expect(group, `command group "${name}" must exist`).toBeDefined();
  return (group as Command).commands.map((command) => command.name());
}

function optionFlags(program: Command, name: string): string[] {
  const command = program.commands.find((entry) => entry.name() === name);
  expect(command, `command "${name}" must exist`).toBeDefined();
  return (command as Command).options.map((option) => option.long ?? option.short ?? '');
}

describe('program registration (Build Contract §4.9)', () => {
  const program = buildProgram({ cwd: () => '/tmp' });

  it('registers every pinned top-level command', () => {
    const names = commandNames(program);
    for (const expected of [
      'init',
      'ask',
      'explain',
      'review',
      'patch',
      'run',
      'status',
      'logs',
      'apply',
      'branch',
      'reject',
      'pr-summary',
      'pr-create',
      'cmux',
      'doctor',
      'workflows',
      'methodologies',
      'models',
      'daily',
      'weekly-plan',
      'discovery',
      'login',
      'connect',
      'sync',
      'extensions',
      'instructions',
      'skills',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('registers the extensions subcommands', () => {
    const names = subcommandNames(program, 'extensions');
    for (const expected of ['list', 'validate', 'doctor', 'enable', 'disable', 'install', 'create']) {
      expect(names).toContain(expected);
    }
  });

  it('registers the instructions subcommands (ISD §7)', () => {
    const names = subcommandNames(program, 'instructions');
    for (const expected of ['scan', 'list', 'inspect', 'enable', 'disable', 'import', 'doctor']) {
      expect(names).toContain(expected);
    }
  });

  it('registers the skills subcommands (ISD §7)', () => {
    const names = subcommandNames(program, 'skills');
    for (const expected of ['list', 'inspect', 'enable', 'disable']) {
      expect(names).toContain(expected);
    }
  });

  it('registers workflows/methodologies/models subcommands', () => {
    expect(subcommandNames(program, 'workflows')).toEqual(expect.arrayContaining(['list', 'explain']));
    expect(subcommandNames(program, 'methodologies')).toEqual(expect.arrayContaining(['list']));
    expect(subcommandNames(program, 'models')).toEqual(expect.arrayContaining(['list', 'setup']));
  });

  it('pins the run command flags', () => {
    const flags = optionFlags(program, 'run');
    for (const expected of [
      '--level',
      '--fast',
      '--careful',
      '--structured',
      '--explore',
      '--workflow',
      '--output',
      '--yes',
    ]) {
      expect(flags).toContain(expected);
    }
  });

  it('pins the discovery command flags', () => {
    const flags = optionFlags(program, 'discovery');
    for (const expected of ['--type', '--from-file', '--from-linear', '--from-jira', '--from-github-issue', '--yes']) {
      expect(flags).toContain(expected);
    }
  });

  it('pins the init modes and skill safety flags', () => {
    expect(optionFlags(program, 'init')).toEqual(
      expect.arrayContaining(['--team', '--full', '--force', '--yes']),
    );
    const skills = program.commands.find((command) => command.name() === 'skills') as Command;
    const enable = skills.commands.find((command) => command.name() === 'enable') as Command;
    expect(enable.options.map((option) => option.long)).toContain('--accept-risk');
    const instructions = program.commands.find((command) => command.name() === 'instructions') as Command;
    const importCommand = instructions.commands.find((command) => command.name() === 'import') as Command;
    expect(importCommand.options.map((option) => option.long)).toContain('--include-global');
  });

  it('exposes the version', () => {
    expect(CLI_VERSION).toBe('0.1.0');
  });
});
