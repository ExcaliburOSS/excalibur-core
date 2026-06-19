import type { ExcaliburEvent } from '@excalibur/shared';
import { formatDiffStat, parseDiffStat } from './diff-stat.js';
import type {
  ApprovalPrompt,
  Phase,
  PhaseEvent,
  RailModel,
  RunStatus,
  TodoItem,
} from './rail-types.js';

/**
 * The keystone of the LIVING RAIL: folds an `ExcaliburEvent` stream into a
 * {@link RailModel}. Pure + total — the SAME function drives the live view, an
 * Esc-Esc scrub (a prefix of the stream) and a replay, so all three are
 * byte-identical. No Ink, no I/O: snapshot-testable against recorded events.
 */

export interface ReduceRailOptions {
  autonomyLabel?: string;
  safety?: string;
  model?: string;
  push?: boolean;
  /** Wall-clock now (ms) for elapsed when the run has not completed. */
  nowMs?: number;
}

/** Reads a string payload field, or ''. */
function str(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

/** Maps a within-phase event to a rail PhaseEvent line, or null to ignore it. */
function railEventFor(event: ExcaliburEvent): PhaseEvent | null {
  const p = event.payload;
  switch (event.type) {
    case 'tool_call':
      return {
        text: `tool ${str(p, 'tool') || str(p, 'name')}`.trim(),
        tone: 'accent',
        kind: 'tool',
      };
    case 'file_read':
      return { text: `read ${str(p, 'path')}`, tone: 'muted', kind: 'read' };
    case 'file_write':
      return { text: `write ${str(p, 'path')}`, tone: 'accent', kind: 'write' };
    case 'command_started':
      return { text: `$ ${str(p, 'command')}`, tone: 'muted', kind: 'command' };
    case 'command_completed': {
      const exit = typeof p['exitCode'] === 'number' ? (p['exitCode'] as number) : null;
      return exit === null
        ? null
        : { text: `exit ${exit}`, tone: exit === 0 ? 'success' : 'warn', kind: 'exit' };
    }
    case 'test_result':
      return { text: `tests ${str(p, 'status') || 'passed'}`, tone: 'success', kind: 'test' };
    case 'patch_generated': {
      const diff = str(p, 'diff');
      const note = formatDiffStat(parseDiffStat(diff));
      return {
        text: 'patch generated',
        tone: 'warn',
        kind: 'patch',
        ...(note.length > 0 ? { note } : {}),
        ...(diff.length > 0 ? { diff } : {}),
      };
    }
    case 'patch_applied':
      return { text: 'patch applied', tone: 'warn', kind: 'patch' };
    case 'branch_created':
      return { text: `branch ${str(p, 'branch')}`, tone: 'accent', kind: 'branch' };
    case 'compaction':
      return { text: 'compacted context', tone: 'muted', kind: 'compaction' };
    case 'diagnostics': {
      const errors = typeof p['errorCount'] === 'number' ? (p['errorCount'] as number) : 0;
      const warnings = typeof p['warningCount'] === 'number' ? (p['warningCount'] as number) : 0;
      const file = str(p, 'file');
      return {
        text: `diagnostics ${file}: ${errors}E ${warnings}W`.trim(),
        tone: errors > 0 ? 'warn' : 'success',
        kind: 'diagnostics',
      };
    }
    default:
      return null;
  }
}

/** Folds the event stream into the rail model. */
export function reduceRail(
  events: ReadonlyArray<ExcaliburEvent>,
  options: ReduceRailOptions = {},
): RailModel {
  const phases: Phase[] = [];
  const phaseById = new Map<string, Phase>();
  const phaseStartMs = new Map<string, number>();
  let runId = '';
  let title = '';
  let done = false;
  let errored = false;
  let costCents = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let approval: ApprovalPrompt | undefined;
  let todos: TodoItem[] | undefined;
  let firstTs: number | undefined;
  let lastTs: number | undefined;

  const current = (): Phase | undefined => phases[phases.length - 1];
  const phaseFor = (event: ExcaliburEvent): Phase | undefined => {
    const id = event.phaseId;
    return id !== null && id !== undefined ? (phaseById.get(id) ?? current()) : current();
  };
  const pushEvent = (phase: Phase | undefined, ev: PhaseEvent): void => {
    if (phase === undefined) return;
    (phase.events ??= []).push(ev);
  };
  // Stamps a phase's wall-clock duration from its start to the current event.
  const setDuration = (phase: Phase): void => {
    const start = phaseStartMs.get(phase.id);
    if (start !== undefined && lastTs !== undefined && phase.durationMs === undefined) {
      phase.durationMs = Math.max(0, lastTs - start);
    }
  };

  for (const event of events) {
    const ts = Date.parse(event.timestamp);
    if (!Number.isNaN(ts)) {
      firstTs ??= ts;
      lastTs = ts;
    }
    const p = event.payload;
    switch (event.type) {
      case 'run_started':
        runId = event.runId ?? runId;
        title = str(p, 'title') || str(p, 'prompt') || title;
        break;
      case 'phase_started': {
        const id = event.phaseId ?? (str(p, 'phaseId') || `phase-${phases.length}`);
        const prev = current();
        if (prev !== undefined && prev.state === 'running') {
          prev.state = 'completed';
        }
        const phase: Phase = { id, name: str(p, 'name') || id, state: 'running', events: [] };
        if (prev !== undefined) setDuration(prev); // prev just rolled to completed
        phases.push(phase);
        phaseById.set(id, phase);
        if (!Number.isNaN(ts)) phaseStartMs.set(id, ts);
        break;
      }
      case 'phase_completed': {
        const ph = phaseFor(event);
        if (ph !== undefined) {
          ph.state = 'completed';
          setDuration(ph);
          const detail = str(p, 'detail');
          if (detail.length > 0) ph.detail = detail;
        }
        break;
      }
      case 'approval_requested': {
        approval = { question: str(p, 'message') || 'Approve?', options: '[y/N/always]' };
        const ph = phaseFor(event);
        if (ph !== undefined) ph.state = 'waiting';
        break;
      }
      case 'approval_approved':
      case 'approval_rejected': {
        approval = undefined;
        const ph = phaseFor(event);
        if (ph !== undefined && ph.state === 'waiting') ph.state = 'running';
        break;
      }
      case 'error': {
        errored = true;
        const ph = phaseFor(event);
        if (ph !== undefined) {
          ph.state = 'failed';
          setDuration(ph);
        }
        pushEvent(ph, { text: str(p, 'message') || 'error', tone: 'warn' });
        break;
      }
      case 'run_completed':
        done = true;
        for (const ph of phases) {
          if (ph.state === 'running' || ph.state === 'waiting') {
            ph.state = 'completed';
            setDuration(ph);
          }
        }
        break;
      case 'task_update': {
        // Last snapshot wins (the model sends the full checklist each time).
        const raw = Array.isArray(p['tasks']) ? (p['tasks'] as unknown[]) : [];
        todos = raw.map((item) => {
          const t = (item ?? {}) as { text?: unknown; status?: unknown };
          return {
            text: typeof t.text === 'string' ? t.text : '',
            status: t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending',
          } satisfies TodoItem;
        });
        break;
      }
      case 'verification': {
        // The adversarial mesh verdict. A blocked verdict gated the run, so the
        // whole run reads as errored even though every phase finished cleanly.
        const blocked = p['blocked'] === true;
        if (blocked) errored = true;
        pushEvent(phaseFor(event), {
          text: str(p, 'summary') || (blocked ? 'verification blocked' : 'verification passed'),
          tone: blocked ? 'warn' : 'success',
          kind: 'verification',
        });
        break;
      }
      case 'claim': {
        // A claim-ledger verdict. A refuted claim means stated success is false
        // → the run reads as errored; verified is success, unverified is muted.
        const status = str(p, 'status');
        if (status === 'refuted') errored = true;
        pushEvent(phaseFor(event), {
          text: `${str(p, 'statement') || 'claim'} — ${status || 'unverified'}`,
          tone: status === 'refuted' ? 'warn' : status === 'verified' ? 'success' : 'muted',
          kind: 'claim',
        });
        break;
      }
      case 'model_call': {
        const c = p['costCents'];
        if (typeof c === 'number') {
          costCents += c;
          const ph = phaseFor(event);
          if (ph !== undefined) ph.costCents = (ph.costCents ?? 0) + c;
        }
        if (typeof p['inputTokens'] === 'number') inputTokens += p['inputTokens'];
        if (typeof p['outputTokens'] === 'number') outputTokens += p['outputTokens'];
        break;
      }
      default: {
        const ev = railEventFor(event);
        if (ev !== null) pushEvent(phaseFor(event), ev);
      }
    }
  }

  // A FINISHED run freezes its elapsed at the final event (lastTs); a LIVE run
  // ticks with wall-clock `nowMs` so the clock breathes between events (the live
  // view passes a fresh nowMs each frame). Preferring lastTs always would freeze
  // the live clock at the last event's timestamp.
  const endMs = done ? (lastTs ?? options.nowMs ?? firstTs) : (options.nowMs ?? lastTs ?? firstTs);
  const elapsedMs = firstTs !== undefined ? Math.max(0, (endMs ?? firstTs) - firstTs) : 0;
  const status: RunStatus = {
    elapsedMs,
    costCents,
    safety: options.safety ?? 'standard-safe',
    push: options.push ?? false,
    model: options.model ?? 'mock',
    inputTokens,
    outputTokens,
  };
  return {
    runId,
    title,
    autonomyLabel: options.autonomyLabel ?? '',
    phases,
    status,
    ...(approval !== undefined ? { approval } : {}),
    ...(todos !== undefined ? { todos } : {}),
    done,
    errored,
  };
}
