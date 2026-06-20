import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browserState, chromiumInstalled, playwrightBrowsersPath } from './browser-manager';

describe('browser-manager', () => {
  let dir: string;
  const prev = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'exc-pw-'));
    process.env['PLAYWRIGHT_BROWSERS_PATH'] = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env['PLAYWRIGHT_BROWSERS_PATH'];
    else process.env['PLAYWRIGHT_BROWSERS_PATH'] = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it('honors PLAYWRIGHT_BROWSERS_PATH', () => {
    expect(playwrightBrowsersPath()).toBe(dir);
  });

  it('reports chromium absent on an empty browsers dir', () => {
    expect(chromiumInstalled()).toBe(false);
  });

  it('detects an installed chromium revision', () => {
    mkdirSync(join(dir, 'chromium-1187'), { recursive: true });
    expect(chromiumInstalled()).toBe(true);
  });

  it('browserState is installed|absent|node-missing (never throws, no install on import)', () => {
    expect(['installed', 'absent', 'node-missing']).toContain(browserState());
  });
});
