<script lang="ts">
  import { approveRun, fetchHealth, fetchRunDetail, fetchRunEvents, ApiError } from '../lib/api';
  import type { RunRecord, ExcaliburEvent } from '../lib/contracts';
  import { t } from '../lib/i18n';

  // DASH4 — per-run detail with a diff/patch viewer. Reads the run record +
  // its event log; the `file_write` events carry the per-edit unified diff
  // (payload.diff) + path, rendered with +/- coloring. A single $effect reloads
  // when the route id changes.
  let { id = '' }: { id?: string } = $props();

  let record = $state<RunRecord | null>(null);
  let events = $state<ExcaliburEvent[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  // F2-1 — the approval gate reviewed IN CONTEXT: writable flag + a reload tick
  // (bumped after a decision and by the light poll while the run is active).
  let writable = $state(false);
  let acting = $state(false);
  let reloadTick = $state(0);
  fetchHealth()
    .then((h) => (writable = h.write))
    .catch(() => {});

  $effect(() => {
    const runId = id;
    void reloadTick;
    let cancelled = false; // a fast id-change must not let a stale response clobber state
    loading = true;
    error = null;
    record = null;
    events = [];
    Promise.all([fetchRunDetail(runId), fetchRunEvents(runId)])
      .then(([detail, ev]) => {
        if (cancelled) return;
        record = detail.record;
        events = ev.events;
      })
      .catch((e) => {
        if (cancelled) return;
        error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  // F2-1 — the pending gate question, derived from the event log the page
  // already fetched: the LAST approval_requested not yet answered/closed.
  const pendingQuestion = $derived.by(() => {
    let q: string | null = null;
    for (const e of events) {
      if (e.type === 'approval_requested') {
        const p = e.payload as { message?: unknown; question?: unknown };
        q =
          (typeof p.message === 'string' && p.message.length > 0 ? p.message : null) ??
          (typeof p.question === 'string' && p.question.length > 0 ? p.question : null) ??
          'Approve?';
      } else if (
        e.type === 'approval_approved' ||
        e.type === 'approval_rejected' ||
        e.type === 'run_completed'
      ) {
        q = null;
      }
    }
    return q;
  });
  const gateOpen = $derived(record?.status === 'waiting_approval');

  async function decide(decision: boolean): Promise<void> {
    acting = true;
    try {
      await approveRun(id, decision);
    } catch {
      /* the reload below shows the truth either way */
    }
    acting = false;
    reloadTick += 1;
  }

  // While the run is in flight, keep the page fresh (5s — same cadence as Runs).
  $effect(() => {
    const active = record?.status === 'running' || record?.status === 'waiting_approval';
    if (!active) return undefined;
    const timer = setInterval(() => (reloadTick += 1), 5000);
    return () => clearInterval(timer);
  });

  interface FileChange {
    path: string;
    lines: string[];
    add: number;
    del: number;
  }

  // The file-mutating events (write_file / edit) that carry a diff.
  const changes = $derived<FileChange[]>(
    events
      .filter((e) => e.type === 'file_write' && typeof (e.payload as { diff?: unknown }).diff === 'string')
      .map((e) => {
        const p = e.payload as { path?: string; diff?: string };
        // Drop a single trailing newline so split() doesn't yield a phantom empty line.
        const lines = (p.diff ?? '').replace(/\n$/, '').split('\n');
        return {
          path: p.path ?? '?',
          lines,
          add: lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
          del: lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
        };
      }),
  );
  const totalAdd = $derived(changes.reduce((n, c) => n + c.add, 0));
  const totalDel = $derived(changes.reduce((n, c) => n + c.del, 0));

  function lineClass(line: string): string {
    if (line.startsWith('+') && !line.startsWith('+++')) return 'add';
    if (line.startsWith('-') && !line.startsWith('---')) return 'del';
    if (line.startsWith('@@')) return 'hunk';
    return '';
  }

  const when = (iso: string | null): string => {
    if (iso === null) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  };
</script>

<a class="back" href="#/runs">{t('runDetail.back')}</a>

{#if loading}
  <div class="state muted">{t('common.loading')}</div>
{:else if error !== null}
  <div class="state bad">{t('common.error')}: {error}</div>
{:else if record === null}
  <div class="state muted">{t('runDetail.notFound')}</div>
{:else}
  <h1>{record.title}</h1>
  <div class="meta faint">
    <span class="st st-{record.status}">{t('status.' + record.status)}</span>
    <span>{record.workflow}</span>
    {#if record.model}<span>{record.model}</span>{/if}
    <span class="mono">{record.id}</span>
    <span>{when(record.startedAt)}</span>
  </div>

  {#if gateOpen}
    <div class="gate">
      <div class="gq">⚑ {pendingQuestion ?? t('runDetail.gateTitle')}</div>
      <div class="muted small">{t('runDetail.gateHint')}</div>
      {#if writable}
        <div class="gactions">
          <button class="btn btn--primary" disabled={acting} onclick={() => decide(true)}>
            {t('workItem.approve')}
          </button>
          <button class="btn btn--danger" disabled={acting} onclick={() => decide(false)}>
            {t('workItem.reject')}
          </button>
        </div>
      {:else}
        <div class="muted small">{t('runDetail.gateReadOnly')}</div>
      {/if}
    </div>
  {/if}

  <h2>{t('runDetail.changes')}</h2>
  {#if changes.length === 0}
    <div class="muted small">{t('runDetail.noChanges')}</div>
  {:else}
    <div class="summary faint">
      {t('runDetail.filesChanged', { n: changes.length, add: totalAdd, del: totalDel })}
    </div>
    {#each changes as c, i (i)}
      <div class="file">
        <div class="fhead">
          <span class="fpath mono">{c.path}</span>
          <span class="fstat"><span class="plus">+{c.add}</span> <span class="minus">−{c.del}</span></span>
        </div>
        <pre class="diff">{#each c.lines as line, li (li)}<span class="dl {lineClass(line)}">{line}</span>{/each}</pre>
      </div>
    {/each}
  {/if}

  <h2>{t('runDetail.events')}</h2>
  <div class="muted small">{t('runDetail.eventCount', { n: events.length })}</div>
{/if}

<style>
  h1 {
    font-size: 22px;
    margin-bottom: 6px;
  }
  h2 {
    font-size: 15px;
    margin: 22px 0 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--line);
  }
  .gate {
    border: 1px solid color-mix(in srgb, var(--warn) 55%, var(--line));
    background: color-mix(in srgb, var(--warn) 8%, transparent);
    border-radius: var(--radius);
    padding: 14px 16px;
    margin: 14px 0 4px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .gq {
    font-weight: 600;
    color: var(--text);
  }
  .gactions {
    display: flex;
    gap: 10px;
    margin-top: 2px;
  }
  .back {
    display: inline-block;
    margin-bottom: 12px;
    color: var(--muted);
    font-size: 13px;
  }
  .state {
    padding: 48px 0;
    text-align: center;
  }
  .meta {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    font-size: 12px;
    align-items: center;
  }
  .mono {
    font-family: var(--mono);
  }
  .st {
    font-size: 10px;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--panel-2);
  }
  .st-completed {
    color: var(--ok);
  }
  .st-failed {
    color: var(--bad);
  }
  .st-running {
    color: var(--accent);
  }
  .summary {
    font-size: 12px;
    margin-bottom: 10px;
  }
  .file {
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    margin-bottom: 12px;
    overflow: hidden;
  }
  .fhead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: var(--panel-2);
    padding: 6px 12px;
    border-bottom: 1px solid var(--line);
    font-size: 12px;
  }
  .fstat {
    font-size: 11px;
  }
  .plus {
    color: var(--ok);
  }
  .minus {
    color: var(--bad);
  }
  .diff {
    margin: 0;
    padding: 8px 0;
    background: var(--panel);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.45;
    overflow-x: auto;
  }
  .dl {
    display: block;
    padding: 0 12px;
    white-space: pre;
    min-height: 1.45em; /* keep blank diff lines (now newline-free spans) at row height */
  }
  .dl.add {
    background: color-mix(in srgb, var(--ok) 14%, transparent);
  }
  .dl.del {
    background: color-mix(in srgb, var(--bad) 14%, transparent);
  }
  .dl.hunk {
    color: var(--accent);
  }
  .small {
    font-size: 12px;
  }
</style>
