import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestCli, makeTempRepo, removeDir } from '../test-utils';

/** WK2: the local kanban CLI — create → board → move → edit → delete. */

describe('excalibur work-items (local kanban CLI)', () => {
  let repo: string;
  beforeEach(() => {
    repo = makeTempRepo();
  });
  afterEach(() => {
    removeDir(repo);
  });

  it('creates a local item and shows it on the board', async () => {
    await createTestCli({ cwd: repo }).run('work-items', 'create', 'Build the thing');
    const cli = createTestCli({ cwd: repo });
    await cli.run('work-items', 'board');
    expect(cli.stdout()).toMatch(/To do/);
    expect(cli.stdout()).toMatch(/WI-1/);
    expect(cli.stdout()).toMatch(/Build the thing/);
  });

  it('moves an item to another lane', async () => {
    await createTestCli({ cwd: repo }).run('work-items', 'create', 'Ship it');
    await createTestCli({ cwd: repo }).run('work-items', 'move', 'WI-1', 'in_progress');
    const cli = createTestCli({ cwd: repo });
    await cli.run('work-items', 'board', '--json');
    const board = JSON.parse(cli.stdout()) as Array<{
      lane: string;
      items: Array<{ key: string }>;
    }>;
    const inProgress = board.find((l) => l.lane === 'in_progress');
    expect(inProgress?.items.map((i) => i.key)).toEqual(['WI-1']);
  });

  it('rejects an invalid lane', async () => {
    await createTestCli({ cwd: repo }).run('work-items', 'create', 'X');
    const cli = createTestCli({ cwd: repo });
    await expect(cli.run('work-items', 'move', 'WI-1', 'nonsense')).rejects.toThrow(
      /lane must be/i,
    );
  });

  it('edits fields and reflects them in the item', async () => {
    await createTestCli({ cwd: repo }).run('work-items', 'create', 'Task');
    await createTestCli({ cwd: repo }).run(
      'work-items',
      'edit',
      'WI-1',
      '--priority',
      'high',
      '--assignee',
      'rafa',
    );
    const cli = createTestCli({ cwd: repo });
    await cli.run('work-items', 'show', 'WI-1', '--local', '--json');
    const item = JSON.parse(cli.stdout()) as {
      priority: string;
      assignee: { name: string } | null;
    };
    expect(item.priority).toBe('high');
    expect(item.assignee?.name).toBe('rafa');
  });

  it('deletes an item', async () => {
    await createTestCli({ cwd: repo }).run('work-items', 'create', 'Temp');
    await createTestCli({ cwd: repo }).run('work-items', 'delete', 'WI-1');
    const cli = createTestCli({ cwd: repo });
    await cli.run('work-items', 'board');
    expect(cli.stdout()).toMatch(/No local work items/);
  });
});
