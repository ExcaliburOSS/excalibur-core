import { describe, expect, it } from 'vitest';
import { CommandParseError, ExcaliburError } from '@excalibur/shared';
import {
  commandToAction,
  DISCOVERY_SUBCOMMANDS,
  EXCALIBUR_COMMANDS,
  parseExcaliburCommand,
  PLANNING_SUBCOMMANDS,
  type ParsedExcaliburCommand,
  type WorkItemCommandAction,
} from './commands';

function parseOrFail(text: string): ParsedExcaliburCommand {
  const parsed = parseExcaliburCommand(text);
  expect(parsed).not.toBeNull();
  return parsed as ParsedExcaliburCommand;
}

describe('EXCALIBUR_COMMANDS', () => {
  it('contains the full work-item, agile and discovery vocabulary', () => {
    expect([...EXCALIBUR_COMMANDS]).toEqual([
      'refine',
      'plan',
      'review',
      'suggest-patch',
      'generate-tests',
      'implement',
      'careful',
      'explore',
      'status',
      'cancel',
      'daily',
      'planning',
      'discovery',
      'readiness',
      'acceptance-criteria',
      'split-scope',
    ]);
  });

  it('pins planning and discovery subcommand vocabularies', () => {
    expect([...PLANNING_SUBCOMMANDS]).toEqual([
      'start',
      'propose',
      'approve',
      'revise',
      'add',
      'remove',
      'owner',
      'careful',
      'run',
    ]);
    expect([...DISCOVERY_SUBCOMMANDS]).toEqual([
      'complete',
      'create-linear',
      'update-ticket',
      'create-run',
      'save-decision',
    ]);
  });
});

describe('parseExcaliburCommand — mention detection', () => {
  it('returns null when there is no mention', () => {
    expect(parseExcaliburCommand('Please take a look at this ticket.')).toBeNull();
    expect(parseExcaliburCommand('')).toBeNull();
    expect(parseExcaliburCommand('excalibur status')).toBeNull();
  });

  it('does not treat email addresses or similar handles as mentions', () => {
    expect(parseExcaliburCommand('Contact support@excalibur.dev for help')).toBeNull();
    expect(parseExcaliburCommand('cc @excalibur-bot please')).toBeNull();
    expect(parseExcaliburCommand('see @excalibur.dev docs')).toBeNull();
    expect(parseExcaliburCommand('version v2@excalibur2 deployed')).toBeNull();
  });

  it('matches the mention case-insensitively', () => {
    expect(parseOrFail('@Excalibur status').command).toBe('status');
    expect(parseOrFail('@EXCALIBUR status').command).toBe('status');
    expect(parseOrFail('@eXcAlIbUr status').command).toBe('status');
  });

  it('accepts the command case-insensitively and normalizes it', () => {
    expect(parseOrFail('@excalibur STATUS').command).toBe('status');
    expect(parseOrFail('@excalibur Suggest-Patch').command).toBe('suggest-patch');
  });

  it('finds the mention embedded in surrounding prose', () => {
    const parsed = parseOrFail(
      'Hey team, can @excalibur implement --repo quickcontract-api before Friday?',
    );
    expect(parsed.command).toBe('implement');
    expect(parsed.flags).toEqual({ repo: 'quickcontract-api' });
    expect(parsed.args).toEqual(['before', 'Friday?']);
  });

  it('tolerates a colon or comma right after the mention', () => {
    expect(parseOrFail('@excalibur: status').command).toBe('status');
    expect(parseOrFail('@excalibur, status please').command).toBe('status');
  });

  it('strips trailing prose punctuation from the command token', () => {
    expect(parseOrFail('(see @excalibur status)').command).toBe('status');
    expect(parseOrFail('try @excalibur daily.').command).toBe('daily');
  });

  it('uses only the first mention', () => {
    const parsed = parseOrFail('@excalibur status\n@excalibur cancel');
    expect(parsed.command).toBe('status');
  });

  it('parses a mention in the middle of a multiline comment, scoped to its line', () => {
    const text = [
      'Context: payouts are failing intermittently in staging.',
      'We suspect the retry handler.',
      '@excalibur implement --repo quickcontract-api --branch main',
      'Thanks! Ping me when the branch is ready.',
    ].join('\n');
    const parsed = parseOrFail(text);
    expect(parsed.command).toBe('implement');
    expect(parsed.flags).toEqual({ repo: 'quickcontract-api', branch: 'main' });
    expect(parsed.args).toEqual([]);
    expect(parsed.raw).toBe('@excalibur implement --repo quickcontract-api --branch main');
  });

  it('handles a mention on the last line without a trailing newline', () => {
    const parsed = parseOrFail('Some context first.\n@excalibur review');
    expect(parsed.command).toBe('review');
  });

  it('returns null when the only @excalibur token is not a command mention', () => {
    expect(parseExcaliburCommand('the @excalibur.dev site is down')).toBeNull();
  });

  it('throws when a mention has no command on its line', () => {
    expect(() => parseExcaliburCommand('@excalibur')).toThrow(CommandParseError);
    expect(() => parseExcaliburCommand('hey @excalibur\nstatus')).toThrow(CommandParseError);
  });
});

describe('parseExcaliburCommand — every command', () => {
  const simpleCommands = EXCALIBUR_COMMANDS.filter((command) => command !== 'planning');

  it.each(simpleCommands.map((command) => [command]))('parses "@excalibur %s"', (command) => {
    const parsed = parseOrFail(`@excalibur ${command}`);
    expect(parsed.command).toBe(command);
    expect(parsed.args).toEqual([]);
    expect(parsed.flags).toEqual({});
    expect(parsed.raw).toBe(`@excalibur ${command}`);
    expect(parsed.subcommand).toBeUndefined();
  });

  it.each(PLANNING_SUBCOMMANDS.map((subcommand) => [subcommand]))(
    'parses "@excalibur planning %s"',
    (subcommand) => {
      const parsed = parseOrFail(`@excalibur planning ${subcommand}`);
      expect(parsed.command).toBe('planning');
      expect(parsed.subcommand).toBe(subcommand);
      expect(parsed.args).toEqual([]);
    },
  );

  it('throws CommandParseError with code command_parse for unknown commands', () => {
    let caught: unknown;
    try {
      parseExcaliburCommand('@excalibur deploy production');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CommandParseError);
    expect(caught).toBeInstanceOf(ExcaliburError);
    expect((caught as CommandParseError).code).toBe('command_parse');
    expect((caught as CommandParseError).details).toMatchObject({ command: 'deploy' });
  });

  it('throws for an unknown command even when a later mention is valid', () => {
    expect(() => parseExcaliburCommand('@excalibur frobnicate\n@excalibur status')).toThrow(
      CommandParseError,
    );
  });
});

describe('parseExcaliburCommand — flags', () => {
  it('parses the spec examples verbatim', () => {
    expect(parseOrFail('@excalibur implement --repo quickcontract-api --branch main')).toEqual({
      command: 'implement',
      args: [],
      flags: { repo: 'quickcontract-api', branch: 'main' },
      raw: '@excalibur implement --repo quickcontract-api --branch main',
    });
    expect(parseOrFail('@excalibur careful --workflow structured-feature').flags).toEqual({
      workflow: 'structured-feature',
    });
    expect(parseOrFail('@excalibur explore --output alternatives').flags).toEqual({
      output: 'alternatives',
    });
  });

  it('parses bare flags as boolean true', () => {
    const parsed = parseOrFail('@excalibur generate-tests --branch');
    expect(parsed.flags).toEqual({ branch: true });
  });

  it('parses a bare flag followed by a value flag', () => {
    const parsed = parseOrFail('@excalibur implement --branch --workflow fast-fix');
    expect(parsed.flags).toEqual({ branch: true, workflow: 'fast-fix' });
  });

  it('parses --flag=value form', () => {
    const parsed = parseOrFail('@excalibur implement --repo=quickcontract-api --branch');
    expect(parsed.flags).toEqual({ repo: 'quickcontract-api', branch: true });
  });

  it('keeps the last value when a flag repeats', () => {
    const parsed = parseOrFail('@excalibur implement --repo a --repo b');
    expect(parsed.flags).toEqual({ repo: 'b' });
  });

  it('mixes positional args and flags', () => {
    const parsed = parseOrFail('@excalibur implement DEMO-1 --repo api --branch main extra');
    expect(parsed.args).toEqual(['DEMO-1', 'extra']);
    expect(parsed.flags).toEqual({ repo: 'api', branch: 'main' });
  });

  it('only parses flags from the mention line in multiline comments', () => {
    const parsed = parseOrFail('@excalibur implement --repo api\n--branch main');
    expect(parsed.flags).toEqual({ repo: 'api' });
  });
});

describe('parseExcaliburCommand — planning', () => {
  it('parses planning add with a ticket arg', () => {
    const parsed = parseOrFail('@excalibur planning add ENG-123');
    expect(parsed).toEqual({
      command: 'planning',
      subcommand: 'add',
      args: ['ENG-123'],
      flags: {},
      raw: '@excalibur planning add ENG-123',
    });
  });

  it('parses planning owner with ticket and user mention args', () => {
    const parsed = parseOrFail('@excalibur planning owner ENG-123 @rafael');
    expect(parsed.subcommand).toBe('owner');
    expect(parsed.args).toEqual(['ENG-123', '@rafael']);
  });

  it('parses planning careful and planning run with ticket args', () => {
    expect(parseOrFail('@excalibur planning careful ENG-123').args).toEqual(['ENG-123']);
    expect(parseOrFail('@excalibur planning run ENG-123').args).toEqual(['ENG-123']);
  });

  it('parses planning subcommands case-insensitively', () => {
    expect(parseOrFail('@excalibur PLANNING Start').subcommand).toBe('start');
  });

  it('parses planning with flags after the subcommand', () => {
    const parsed = parseOrFail('@excalibur planning run ENG-123 --workflow fast-fix');
    expect(parsed.subcommand).toBe('run');
    expect(parsed.args).toEqual(['ENG-123']);
    expect(parsed.flags).toEqual({ workflow: 'fast-fix' });
  });

  it('throws when planning has no subcommand', () => {
    expect(() => parseExcaliburCommand('@excalibur planning')).toThrow(CommandParseError);
  });

  it('throws when planning is followed directly by a flag', () => {
    expect(() => parseExcaliburCommand('@excalibur planning --repo api')).toThrow(
      CommandParseError,
    );
  });

  it('throws for an unknown planning subcommand', () => {
    let caught: unknown;
    try {
      parseExcaliburCommand('@excalibur planning frobnicate');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CommandParseError);
    expect((caught as CommandParseError).details).toMatchObject({ subcommand: 'frobnicate' });
  });
});

describe('parseExcaliburCommand — discovery', () => {
  it('parses bare discovery with no subcommand', () => {
    const parsed = parseOrFail('@excalibur discovery');
    expect(parsed.command).toBe('discovery');
    expect(parsed.subcommand).toBeUndefined();
    expect(parsed.args).toEqual([]);
  });

  it.each(DISCOVERY_SUBCOMMANDS.map((subcommand) => [subcommand]))(
    'parses "@excalibur discovery %s"',
    (subcommand) => {
      const parsed = parseOrFail(`@excalibur discovery ${subcommand}`);
      expect(parsed.command).toBe('discovery');
      expect(parsed.subcommand).toBe(subcommand);
    },
  );

  it('treats a non-subcommand token after discovery as a positional arg', () => {
    const parsed = parseOrFail('@excalibur discovery onboarding-revamp');
    expect(parsed.subcommand).toBeUndefined();
    expect(parsed.args).toEqual(['onboarding-revamp']);
  });

  it('parses discovery subcommands with args and flags', () => {
    const parsed = parseOrFail('@excalibur discovery create-run DEMO-1 --workflow fast-fix');
    expect(parsed.subcommand).toBe('create-run');
    expect(parsed.args).toEqual(['DEMO-1']);
    expect(parsed.flags).toEqual({ workflow: 'fast-fix' });
  });

  it('parses the discovery alias commands', () => {
    expect(parseOrFail('@excalibur readiness').command).toBe('readiness');
    expect(parseOrFail('@excalibur acceptance-criteria').command).toBe('acceptance-criteria');
    expect(parseOrFail('@excalibur split-scope').command).toBe('split-scope');
  });
});

describe('commandToAction — full mapping table', () => {
  function actionFor(text: string): WorkItemCommandAction {
    return commandToAction(parseOrFail(text));
  }

  it('maps refine/plan/review to level-0 interactions', () => {
    expect(actionFor('@excalibur refine')).toEqual({
      kind: 'interaction',
      interactionType: 'work_item_refinement',
      autonomyLevel: 0,
    });
    expect(actionFor('@excalibur plan')).toEqual({
      kind: 'interaction',
      interactionType: 'work_item_plan',
      autonomyLevel: 0,
    });
    expect(actionFor('@excalibur review')).toEqual({
      kind: 'interaction',
      interactionType: 'work_item_review',
      autonomyLevel: 0,
    });
  });

  it('maps suggest-patch and generate-tests to level-2 patches', () => {
    expect(actionFor('@excalibur suggest-patch')).toEqual({
      kind: 'patch',
      autonomyLevel: 2,
      variant: 'suggest_patch',
    });
    expect(actionFor('@excalibur generate-tests --branch')).toEqual({
      kind: 'patch',
      autonomyLevel: 2,
      variant: 'generate_tests',
    });
  });

  it('maps implement/careful/explore to runs with execution styles', () => {
    expect(actionFor('@excalibur implement')).toEqual({
      kind: 'run',
      autonomyLevel: 3,
      executionStyle: 'team_default',
    });
    expect(actionFor('@excalibur careful')).toEqual({
      kind: 'run',
      autonomyLevel: 4,
      executionStyle: 'careful',
    });
    expect(actionFor('@excalibur explore')).toEqual({
      kind: 'run',
      autonomyLevel: 3,
      executionStyle: 'explore',
    });
  });

  it('maps status/cancel/daily to their own kinds', () => {
    expect(actionFor('@excalibur status')).toEqual({ kind: 'status' });
    expect(actionFor('@excalibur cancel')).toEqual({ kind: 'cancel' });
    expect(actionFor('@excalibur daily')).toEqual({ kind: 'daily' });
  });

  it.each(PLANNING_SUBCOMMANDS.map((subcommand) => [subcommand]))(
    'maps planning %s to a planning action',
    (subcommand) => {
      expect(actionFor(`@excalibur planning ${subcommand} ENG-123`)).toEqual({
        kind: 'planning',
        action: subcommand,
        args: ['ENG-123'],
      });
    },
  );

  it('maps bare discovery to a discovery action without an action name', () => {
    const action = actionFor('@excalibur discovery');
    expect(action).toEqual({ kind: 'discovery', args: [] });
    expect('action' in action && action.action).toBeFalsy();
  });

  it.each(DISCOVERY_SUBCOMMANDS.map((subcommand) => [subcommand]))(
    'maps discovery %s to a discovery action named after the subcommand',
    (subcommand) => {
      expect(actionFor(`@excalibur discovery ${subcommand}`)).toEqual({
        kind: 'discovery',
        action: subcommand,
        args: [],
      });
    },
  );

  it('maps readiness/acceptance-criteria/split-scope to discovery actions named after the command', () => {
    expect(actionFor('@excalibur readiness DEMO-1')).toEqual({
      kind: 'discovery',
      action: 'readiness',
      args: ['DEMO-1'],
    });
    expect(actionFor('@excalibur acceptance-criteria')).toEqual({
      kind: 'discovery',
      action: 'acceptance-criteria',
      args: [],
    });
    expect(actionFor('@excalibur split-scope')).toEqual({
      kind: 'discovery',
      action: 'split-scope',
      args: [],
    });
  });

  it('covers every command in EXCALIBUR_COMMANDS', () => {
    for (const command of EXCALIBUR_COMMANDS) {
      const text = command === 'planning' ? '@excalibur planning start' : `@excalibur ${command}`;
      expect(() => actionFor(text)).not.toThrow();
    }
  });

  it('throws on a hand-built parsed command with an unknown command', () => {
    const parsed: ParsedExcaliburCommand = {
      command: 'deploy',
      args: [],
      flags: {},
      raw: '@excalibur deploy',
    };
    expect(() => commandToAction(parsed)).toThrow(CommandParseError);
  });

  it('throws on a hand-built planning command without a subcommand', () => {
    const parsed: ParsedExcaliburCommand = {
      command: 'planning',
      args: [],
      flags: {},
      raw: '@excalibur planning',
    };
    expect(() => commandToAction(parsed)).toThrow(CommandParseError);
  });
});
