import { describe, expect, it } from 'vitest';
import type { ExcaliburEvent } from '@excalibur/shared';
import { describeEvent } from './run-pipeline';
import { buildCliTranslator } from '../i18n';

/**
 * RUN-FIX-27 (non-TTY / CI fallback parity with the TTY rail). `describeEvent` renders ONE
 * streamed run event as a plain line. Three properties this locks in:
 *   1. `tool_call` → ONE informative, LOCALIZED verb + the real argument (command / file /
 *      query), never a bare "tool run_command".
 *   2. `file_read` → null (the paired `tool_call` already rendered the read — no duplicate).
 *   3. `command_completed` → ALWAYS null — an exit code (green "exit 0" or scary red "exit 1")
 *      must NEVER surface to the user, even on a benign exploratory probe.
 */

function ev(type: string, payload: Record<string, unknown>): ExcaliburEvent {
  return {
    id: 'e',
    runId: 'run_x',
    type,
    timestamp: '',
    phaseId: null,
    sessionId: null,
    payload,
  } as ExcaliburEvent;
}

// Strip ANSI so assertions read on the plain text (colors are usually a no-op under the test Ui).
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;
function plain(s: string | null): string | null {
  return s === null ? null : s.replace(ANSI, '');
}

describe('describeEvent (non-TTY run-event line)', () => {
  const en = buildCliTranslator('en');
  const es = buildCliTranslator('es');

  it('renders a run_command tool_call as an informative "run <command>" line', () => {
    const line = plain(
      describeEvent(
        en,
        ev('tool_call', { tool: 'run_command', arguments: { command: 'npm test' } }),
      ),
    );
    expect(line).toBe('run npm test');
  });

  it('renders a read as "read <path>", not a bare "tool read_file"', () => {
    const line = plain(
      describeEvent(en, ev('tool_call', { tool: 'read_file', arguments: { path: 'server.js' } })),
    );
    expect(line).toBe('read server.js');
  });

  it('renders a search with its query', () => {
    const line = plain(
      describeEvent(en, ev('tool_call', { tool: 'search_code', arguments: { query: 'escrow' } })),
    );
    expect(line).toBe('search «escrow»');
  });

  it('localizes the verb into the user language (Spanish)', () => {
    const line = plain(
      describeEvent(
        es,
        ev('tool_call', { tool: 'run_command', arguments: { command: 'npm test' } }),
      ),
    );
    expect(line).toBe('ejecuto npm test');
  });

  it('suppresses the write tool_call (the file_write line carries the diffstat)', () => {
    const line = describeEvent(
      en,
      ev('tool_call', { tool: 'write_file', arguments: { path: 'src/new.ts' } }),
    );
    expect(line).toBeNull();
  });

  it('suppresses file_read — the paired tool_call already rendered the read', () => {
    expect(describeEvent(en, ev('file_read', { path: 'a.ts' }))).toBeNull();
  });

  it('NEVER surfaces an exit code — command_completed is always suppressed', () => {
    expect(describeEvent(en, ev('command_completed', { exitCode: 0 }))).toBeNull();
    expect(describeEvent(en, ev('command_completed', { exitCode: 1 }))).toBeNull();
    // A benign exploratory probe returning non-zero must not read as a failure.
    expect(describeEvent(es, ev('command_completed', { exitCode: 1 }))).toBeNull();
  });
});
