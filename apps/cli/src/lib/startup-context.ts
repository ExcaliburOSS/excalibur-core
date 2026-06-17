import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore, plansDir, type LocalSession, type SessionTurn } from '@excalibur/core';
import type { Translator } from '@excalibur/shared';
import { parse as parseYaml } from 'yaml';
import { buildSessionLog } from './session-log';

/** Minimal session-store surface this needs (decouples it from the concrete class). */
interface SessionStoreLike {
  latestSession(): LocalSession | null;
  readTranscript(id: string): SessionTurn[];
}

export interface StartupContext {
  /** Pre-rendered context lines to print after the welcome (may be empty). */
  lines: string[];
  /** The most recent prior session in THIS repo, if any (for a resume offer). */
  latest: LocalSession | null;
}

/** The newest non-cancelled plan's task from `.excalibur/plans/`, or null. */
function newestActivePlan(repoRoot: string): string | null {
  try {
    const dir = plansDir(repoRoot);
    if (!existsSync(dir)) {
      return null;
    }
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse();
    for (const file of files) {
      const m = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(dir, file), 'utf8'));
      const fm = (m !== null ? parseYaml(m[1] ?? '') : {}) as { task?: string; status?: string };
      if (fm.status !== 'cancelled') {
        return fm.task ?? file.replace(/\.md$/, '');
      }
    }
  } catch {
    /* best-effort */
  }
  return null;
}

/**
 * PROACTIVE startup intelligence (no `--continue` needed): on opening the shell,
 * Excalibur reads its own state for THIS repo — the last activity, any active
 * plan, and how many decisions it remembers — and returns lines to surface plus
 * the latest session (so the caller can OFFER to resume). Embodies the
 * "intelligent + proactive, never make the user run arcane commands" directive.
 */
export function buildStartupContext(
  t: Translator,
  repoRoot: string,
  store: SessionStoreLike,
): StartupContext {
  const lines: string[] = [];

  const latest0 = store.latestSession();
  const latest = latest0 !== null && latest0.metadata.repoRoot === repoRoot ? latest0 : null;

  let lastActivity: string | null = null;
  if (latest !== null) {
    try {
      const entries = buildSessionLog(repoRoot, store.readTranscript(latest.id));
      const last = entries[entries.length - 1];
      if (last !== undefined) {
        lastActivity = `${last.title.length > 0 ? last.title : t('session-log.untitled')} (${last.status})`;
      }
    } catch {
      /* best-effort */
    }
  }

  const activePlan = newestActivePlan(repoRoot);

  let memoryCount = 0;
  try {
    memoryCount = new MemoryStore(repoRoot).all().length;
  } catch {
    /* best-effort */
  }

  if (lastActivity !== null) {
    lines.push(t('repl.context-last', { what: lastActivity }));
  }
  if (activePlan !== null) {
    lines.push(t('repl.context-plan', { task: activePlan }));
  }
  if (memoryCount > 0) {
    lines.push(t('repl.context-memory', { count: memoryCount }));
  }

  return { lines, latest };
}
