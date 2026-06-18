import { describe, expect, it } from 'vitest';
import type { ExcaliburEvent } from '@excalibur/shared';
import { ActionRenderer } from './action-render';
import { createInteractiveCli } from '../test-utils';

/**
 * Offline tests for the live per-action renderer. Output is captured via the
 * non-interactive test Ui (ANSI stripped) and asserted on structure: tool
 * blocks (header + indented result), diff gutters, command output + exit code,
 * intermediate narration without final-answer duplication, and the bug fixes
 * (no false "(simulated)"; command results are shown).
 */

function ev(type: string, payload: Record<string, unknown>): ExcaliburEvent {
  return { id: 'e', runId: 'run_x', type, timestamp: '', phaseId: null, sessionId: null, payload } as ExcaliburEvent;
}

function render(events: ExcaliburEvent[]): string {
  const cli = createInteractiveCli({ cwd: '/tmp' });
  let t = 0;
  const renderer = new ActionRenderer(cli.deps, { unicode: true, clock: () => (t += 600) });
  for (const event of events) {
    renderer.onEvent(event);
  }
  renderer.finish();
  return cli.stdout();
}

const DIFF = [
  'diff --git a/src/charge.ts b/src/charge.ts',
  '--- a/src/charge.ts',
  '+++ b/src/charge.ts',
  '@@ -1,2 +1,3 @@',
  ' export function charge(cart) {',
  '-  return cart.total;',
  '+  if (!cart) return 0;',
  '+  return cart.total;',
].join('\n');

describe('ActionRenderer (live per-action view)', () => {
  it('renders a read as a verb header + line-count result', () => {
    const out = render([
      ev('tool_call', { tool: 'read_file', arguments: { path: 'src/charge.ts' } }),
      ev('file_read', { tool: 'read_file', ok: true, path: 'src/charge.ts', result: 'a\nb\nc' }),
    ]);
    expect(out).toContain('Read');
    expect(out).toContain('src/charge.ts');
    expect(out).toContain('3 lines');
  });

  it('renders update_tasks as the checklist band (not a generic tool block)', () => {
    const out = render([
      ev('tool_call', { tool: 'update_tasks', arguments: { tasks: [] } }),
      ev('task_update', {
        tool: 'update_tasks',
        tasks: [
          { id: 'task-1', text: 'Add validation', status: 'completed' },
          { id: 'task-2', text: 'Wire it up', status: 'in_progress' },
          { id: 'task-3', text: 'Write a test', status: 'pending' },
        ],
      }),
    ]);
    expect(out).toContain('Tasks  1/3');
    expect(out).toContain('Add validation');
    expect(out).toContain('Wire it up');
    expect(out).toContain('Write a test');
    // The generic "update_tasks" call header is suppressed in favour of the band.
    expect(out).not.toContain('update_tasks');
  });

  it('renders an apply_patch with a +/− diff gutter from the call arguments', () => {
    const out = render([
      ev('tool_call', { tool: 'apply_patch', arguments: { diff: DIFF } }),
      ev('patch_applied', { tool: 'apply_patch', ok: true, simulated: false, result: 'applied' }),
    ]);
    expect(out).toContain('Patch');
    expect(out).toContain('+  if (!cart) return 0;');
    expect(out).toContain('-  return cart.total;');
    // Structural diff lines (---/+++/@@) are filtered out of the gutter.
    expect(out).not.toContain('@@ -1,2');
  });

  it('shows command output tail + exit code (the previously-dropped result)', () => {
    const out = render([
      ev('tool_call', { tool: 'run_tests', arguments: { command: 'npm test' } }),
      ev('command_completed', {
        tool: 'run_tests',
        ok: true,
        command: 'npm test',
        exitCode: 0,
        result: '> jest\n\n142 passed, 0 failed\nDone in 1.2s',
      }),
    ]);
    expect(out).toContain('Test');
    expect(out).toContain('exit 0');
    expect(out).toContain('Done in 1.2s');
    // The banner line is dropped in favor of the useful tail.
    expect(out).not.toContain('> jest');
  });

  it('renders a failed command in place with its error tail', () => {
    const out = render([
      ev('tool_call', { tool: 'run_command', arguments: { command: 'npm run build' } }),
      ev('command_completed', { tool: 'run_command', ok: false, command: 'npm run build', exitCode: 1, result: 'error TS2554: Expected 1 arguments.' }),
    ]);
    expect(out).toContain('Bash');
    expect(out).toContain('error TS2554');
  });

  it('shows intermediate narration before a tool, but never the final answer', () => {
    const out = render([
      ev('model_call', { model: 'm', content: 'First I will read the file.' }),
      ev('tool_call', { tool: 'read_file', arguments: { path: 'a.ts' } }),
      ev('file_read', { tool: 'read_file', ok: true, path: 'a.ts', result: 'x' }),
      ev('model_call', { model: 'm', content: 'All done — this is the final answer.' }),
      ev('assistant_message', { content: 'All done — this is the final answer.' }),
    ]);
    expect(out).toContain('First I will read the file.');
    // The final answer belongs to the receipt, not the action stream.
    expect(out).not.toContain('All done — this is the final answer.');
  });

  it('does NOT label a real write as simulated', () => {
    const out = render([
      ev('tool_call', { tool: 'write_file', arguments: { path: 'src/new.ts' } }),
      ev('file_write', { tool: 'write_file', ok: true, path: 'src/new.ts', result: 'wrote 40 bytes to "src/new.ts"' }),
    ]);
    expect(out).toContain('Write');
    expect(out).not.toContain('simulated');
  });

  it('renders a declined mutation indented as a result line', () => {
    const out = render([
      ev('tool_call', { tool: 'write_file', arguments: { path: '.env' } }),
      ev('policy_decision', { kind: 'confirmation', decision: 'deny', tool: 'write_file', message: 'user declined: blocked path' }),
    ]);
    expect(out).toContain('user declined: blocked path');
  });

  it('renders a standalone error (✗) when no tool call is open — no dangling ⎿', () => {
    const out = render([ev('error', { message: 'run failed before any tool' })]);
    expect(out).toContain('✗');
    expect(out).toContain('run failed before any tool');
    expect(out).not.toContain('⎿'); // no connector pointing at a non-existent header
  });

  it('"N more diff lines" counts only elided CHANGE lines, not skipped context', () => {
    // 10 shown (BODY_CAP), then context (must NOT count) + 5 more changes (count).
    const body: string[] = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,20 +1,20 @@'];
    for (let i = 0; i < 10; i += 1) body.push(`+added ${i}`);
    for (let i = 0; i < 4; i += 1) body.push(` context ${i}`); // beyond the cap → skipped
    for (let i = 0; i < 5; i += 1) body.push(`+overflow ${i}`); // beyond the cap → hidden
    const out = render([
      ev('tool_call', { tool: 'apply_patch', arguments: { diff: body.join('\n') } }),
      ev('patch_applied', { tool: 'apply_patch', ok: true, result: 'applied' }),
    ]);
    expect(out).toContain('+5 more diff lines'); // 5, not 9 (the 4 context lines don't count)
  });
});
