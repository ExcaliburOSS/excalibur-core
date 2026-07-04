import { stripReasoning, type ExcaliburEvent } from '@excalibur/shared';
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
  /**
   * Optional translator (RUN-FIX-27): when the live m-shell passes `deps.t`, the tool-action
   * verbs (read / run / search / write) render in the USER'S language. The reducer stays usable
   * with NO translator — the golden tests, the dashboard and any headless caller fall back to
   * the English literal — so it remains pure + snapshot-testable.
   */
  t?: (key: string, vars?: Record<string, string | number>) => string;
}

type RailT = NonNullable<ReduceRailOptions['t']>;

/** Localize a rail line via the injected translator, or fall back to the English literal
 * (interpolating `{arg}`) when none is provided. */
function label(
  t: RailT | undefined,
  key: string,
  fallback: string,
  vars: Record<string, string | number> = {},
): string {
  if (t !== undefined) return t(key, vars);
  return fallback.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}

/** Reads a string payload field, or ''. */
function str(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

/** Trim a long argument (a command / query) so a tool line never wraps into noise. */
function clip(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * RUN-FIX-27 — ONE informative line per tool call: a verb + the REAL argument (the command for
 * run_command, the file for reads/writes, the query for a search) — "run npm test", "read
 * package.json", "search «escrow»" — instead of a bare, uninformative "tool run_command".
 * The `tool_call` announce already carries `arguments`, so this line stands alone and the
 * redundant typed follow-ups (file_read / command_started / command_completed) are suppressed,
 * killing the old two-line "◈ tool read_file" + "▭ read package.json" duplication. Write/edit
 * return null here so the richer `file_write` line (with its diffstat) is the one that shows.
 */
function describeToolCall(tool: string, rawArgs: unknown, t?: RailT): PhaseEvent | null {
  const a = (rawArgs ?? {}) as Record<string, unknown>;
  const s = (k: string): string => (typeof a[k] === 'string' ? (a[k] as string) : '');
  switch (tool) {
    case 'read_file':
      return {
        text: label(t, 'tool.read', 'read {arg}', { arg: s('path') }),
        tone: 'muted',
        kind: 'read',
      };
    case 'list_files':
      return {
        text: label(t, 'tool.list', 'list {arg}', { arg: s('path') || '.' }),
        tone: 'muted',
        kind: 'read',
      };
    case 'search_code':
    case 'search': {
      const q = s('query') || s('pattern');
      return {
        text: label(t, 'tool.search', 'search «{arg}»', { arg: clip(q) }),
        tone: 'muted',
        kind: 'read',
      };
    }
    case 'write_file':
    case 'edit':
      return null; // the `file_write` line renders this with its diffstat
    case 'run_command':
    case 'run_tests': {
      const cmd = s('command');
      return {
        text: label(t, 'tool.run', 'run {arg}', { arg: cmd.length > 0 ? clip(cmd) : tool }),
        tone: 'accent',
        kind: 'command',
      };
    }
    case 'preview':
      return { text: label(t, 'tool.preview', 'preview the app'), tone: 'accent', kind: 'command' };
    default: {
      const name = tool.replace(/_/g, ' ').trim();
      return {
        text: label(t, 'tool.name', '{arg}', { arg: name.length > 0 ? name : 'tool' }),
        tone: 'accent',
        kind: 'tool',
      };
    }
  }
}

/** Maps a within-phase event to a rail PhaseEvent line, or null to ignore it. */
function railEventFor(event: ExcaliburEvent, t?: RailT): PhaseEvent | null {
  const p = event.payload;
  switch (event.type) {
    case 'tool_call':
      return describeToolCall(str(p, 'tool') || str(p, 'name'), p['arguments'], t);
    // Suppressed: the tool_call announce (above) already describes the read with its path, so
    // rendering file_read again produced the old redundant second line (RUN-FIX-27). NOTE we
    // keep `command_started` below ($ command) — the gated workflow engine surfaces commands
    // through it, NOT through a tool_call announce, so it is a flow's ONLY command line.
    case 'file_read':
      return null;
    case 'file_write': {
      // AO6 Pillar 1: the adapter carries a per-edit unified diff so the live
      // rail streams the highlighted change inline (collapsible) right after the
      // write line — CC-parity. The diffstat rides along as the line annotation.
      const diff = str(p, 'diff');
      const note = diff.length > 0 ? formatDiffStat(parseDiffStat(diff)) : '';
      return {
        text: label(t, 'tool.write', 'write {arg}', { arg: str(p, 'path') }),
        tone: 'accent',
        kind: 'write',
        ...(note.length > 0 ? { note } : {}),
        ...(diff.length > 0 ? { diff } : {}),
      };
    }
    case 'command_started':
      return { text: `$ ${str(p, 'command')}`, tone: 'muted', kind: 'command' };
    case 'command_completed':
      // NEVER surface a raw exit code to the user (RUN-FIX-27): "exit 0" is noise and
      // "exit 1" is scary technical jargon (and often just an exploratory probe — a
      // missing dir, an empty grep). The `$ command` line already stands; a genuine
      // failure surfaces through the agent's own narration + recovery, not a bare code.
      return null;
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
    // #2 live timeline — stamp each action's wall-clock start so the renderer can
    // show a per-action elapsed timer. `lastTs` is the CURRENT event's timestamp.
    if (ev.startedAtMs === undefined && lastTs !== undefined) {
      ev.startedAtMs = lastTs;
    }
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
        // A descriptive `detail` set at START makes the ACTIVE header a sentence
        // about the work ("Context Discovery · reading the codebase…") instead of a
        // bare word; phase_completed may later overwrite it with an outcome detail.
        const startDetail = str(p, 'detail');
        if (startDetail.length > 0) phase.detail = startDetail;
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
        // The conversational gate sets `message`; the workflow engine sets `question`
        // — accept either so BOTH paths show the real question (not the fallback).
        approval = {
          question: str(p, 'message') || str(p, 'question') || 'Approve?',
          options: '[y/N/always]',
        };
        const ph = phaseFor(event);
        if (ph !== undefined) ph.state = 'waiting';
        break;
      }
      case 'approval_approved':
      case 'approval_rejected': {
        approval = undefined;
        const ph = phaseFor(event);
        if (ph !== undefined && ph.state === 'waiting') ph.state = 'running';
        // Commit the resolved Q&A as a PERSISTENT line (the live prompt above was
        // transient and vanished on answer). `decision` is a host-localized label
        // ("aprobado"/"rechazado"); fall back to a neutral English word. Tone +
        // the "→ decision" suffix carry approve vs decline. This line is NOT popped
        // (only trailing `narration` is) and is surfaced even for a completed phase
        // (RunView) so it lands in scrollback.
        const approved = event.type === 'approval_approved';
        const question = str(p, 'message') || str(p, 'question');
        if (question.length > 0) {
          const decision = str(p, 'decision') || (approved ? 'approved' : 'declined');
          pushEvent(ph, {
            text: `${question} → ${decision}`,
            tone: approved ? 'success' : 'warn',
            kind: 'approval',
          });
        }
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
        // A finished run can never be answered — clear any approval still pending in
        // the fold (e.g. a turn aborted mid-gate) so neither the final live frame nor
        // a replay renders a stale, unanswerable "… needs approval [y/N/a]" prompt.
        approval = undefined;
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
        // The model's own prose for this turn — the warm interstitial narration.
        // Surface it as flowing text (a `narration` line) so the user reads what
        // the agent is thinking BETWEEN actions, not just a mechanical tool log.
        // Defense-in-depth (RUN-FIX-22): strip any reasoning that slipped past the adapter
        // before the narration is folded into a committed rail line.
        const said = stripReasoning(str(p, 'content')).trim();
        if (said.length > 0) {
          pushEvent(phaseFor(event), { text: said, tone: 'accent', kind: 'narration' });
        }
        break;
      }
      case 'assistant_message': {
        // The FINAL turn's `model_call` carries the same prose as the final answer,
        // which the post-turn receipt renders. Drop that trailing narration line so
        // the answer isn't shown twice (mirrors ActionRenderer.dropNarration).
        const ph = phaseFor(event);
        const evs = ph?.events;
        if (evs !== undefined && evs.length > 0 && evs[evs.length - 1]?.kind === 'narration') {
          evs.pop();
        }
        break;
      }
      default: {
        const ev = railEventFor(event, options.t);
        if (ev !== null) pushEvent(phaseFor(event), ev);
      }
    }
  }

  // #2 live tool-call timeline — mark each phase's ACTION events with a status:
  // the LAST action of a still-running phase is `running` (the renderer paints a
  // live elapsed timer + spinner on it); every earlier action is `done`. Narration
  // lines carry no status. This is what turns the flat action log into a timeline.
  for (const phase of phases) {
    const evs = phase.events;
    if (evs === undefined || evs.length === 0) continue;
    let lastActionIdx = -1;
    for (let i = 0; i < evs.length; i += 1) {
      if (evs[i]!.kind !== 'narration') lastActionIdx = i;
    }
    if (lastActionIdx === -1) continue;
    const liveRunning = phase.state === 'running' && !done;
    for (let i = 0; i < evs.length; i += 1) {
      const e = evs[i]!;
      if (e.kind === 'narration') continue;
      e.status = i === lastActionIdx && liveRunning ? 'running' : 'done';
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
    ...(firstTs !== undefined ? { startedAtMs: firstTs } : {}),
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
