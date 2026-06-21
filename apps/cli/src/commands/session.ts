import { readFileSync, writeFileSync } from 'node:fs';
import { SessionStore, type SessionMetadata, type SessionTurn } from '@excalibur/core';
import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';

/**
 * `excalibur session export|import` (P1.12) — portable session transcripts.
 * Export a session (latest by default) as JSON (round-trippable) or Markdown
 * (human-readable); import a JSON export into a fresh local session. Useful for
 * sharing a debugging session or moving work between machines.
 */

function renderMarkdown(metadata: SessionMetadata, turns: SessionTurn[]): string {
  const lines = [
    `# Session: ${metadata.title}`,
    '',
    `_${metadata.id} · ${metadata.createdAt}_`,
    '',
  ];
  for (const turn of turns) {
    const who = turn.role === 'user' ? 'User' : turn.role === 'assistant' ? 'Agent' : 'System';
    lines.push(`## ${who}${turn.model !== undefined ? ` (${turn.model})` : ''}`, '', turn.text, '');
  }
  return lines.join('\n');
}

export function registerSessionCommand(program: Command, deps: CliDeps): void {
  const session = program
    .command('session')
    .description('export / import interactive sessions (portable transcripts)');

  session
    .command('export')
    .description('export a session (latest if no id) as JSON or Markdown')
    .argument('[id]', 'session id (default: the latest session)')
    .option('--format <json|md>', 'output format', 'json')
    .option('--out <file>', 'write to a file instead of stdout')
    .action((id: string | undefined, options: { format?: string; out?: string }) => {
      const store = new SessionStore(deps.cwd());
      const local = id !== undefined ? store.getSession(id) : store.latestSession();
      if (local === null || local === undefined) {
        throw new CliUsageError('no session found to export.');
      }
      const turns = store.readTranscript(local.id);
      const format = options.format ?? 'json';
      let output: string;
      if (format === 'md') {
        output = renderMarkdown(local.metadata, turns);
      } else if (format === 'json') {
        output = JSON.stringify({ metadata: local.metadata, turns }, null, 2);
      } else {
        throw new CliUsageError('--format must be "json" or "md".');
      }
      if (options.out !== undefined) {
        writeFileSync(options.out, `${output}\n`, 'utf8');
        deps.ui.success(`Exported ${local.id} → ${options.out}`);
      } else {
        deps.ui.write(output);
      }
    });

  session
    .command('import')
    .description('import a session from a JSON export into a new local session')
    .argument('<file>', 'path to a session JSON export')
    .action((file: string) => {
      const store = new SessionStore(deps.cwd());
      let parsed: { metadata?: { title?: unknown }; turns?: unknown };
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8')) as typeof parsed;
      } catch {
        throw new CliUsageError(`could not read a JSON session export from "${file}".`);
      }
      const turns = Array.isArray(parsed.turns) ? parsed.turns : [];
      const title =
        typeof parsed.metadata?.title === 'string' ? parsed.metadata.title : 'imported session';
      const created = store.createSession({ title });
      let imported = 0;
      for (const raw of turns) {
        if (typeof raw !== 'object' || raw === null) continue;
        const turn = raw as Partial<SessionTurn>;
        if (
          typeof turn.role !== 'string' ||
          typeof turn.kind !== 'string' ||
          typeof turn.text !== 'string'
        ) {
          continue;
        }
        try {
          store.appendTurn(created.id, {
            role: turn.role,
            kind: turn.kind,
            text: turn.text,
            ...(typeof turn.model === 'string' ? { model: turn.model } : {}),
            ...(typeof turn.route === 'string' ? { route: turn.route } : {}),
          });
          imported += 1;
        } catch {
          /* skip a turn with an unrecognized role/kind */
        }
      }
      deps.ui.success(`Imported ${imported} turn(s) → ${created.id}`);
    });
}
