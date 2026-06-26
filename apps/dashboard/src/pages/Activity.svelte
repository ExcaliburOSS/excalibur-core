<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fetchRuns, ApiError } from '../lib/api';
  import type { RunRecord } from '../lib/contracts';
  import { t } from '../lib/i18n';

  // Activity is a chronological chronicle of what's happened across tasks —
  // each execution placed on a timeline, linked back to the task it advanced.
  // (No internal sub-views; this is the human-readable event stream.)
  let runs = $state<RunRecord[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let timer: ReturnType<typeof setInterval> | null = null;

  async function load(quiet = false): Promise<void> {
    if (!quiet) loading = true;
    try {
      runs = (await fetchRuns()).runs;
      error = null;
    } catch (e) {
      if (runs.length === 0) error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
    // Keep the chronicle fresh without a manual refresh.
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 5000);
  });
  onDestroy(() => {
    if (timer !== null) clearInterval(timer);
  });

  interface Ev {
    at: number;
    iso: string;
    status: string;
    run: RunRecord;
  }

  // One entry per execution at its most recent moment (finished, else started),
  // newest first.
  const events = $derived(
    runs
      .map((r): Ev => {
        const iso = r.completedAt ?? r.startedAt;
        return { at: new Date(iso).getTime(), iso, status: r.status, run: r };
      })
      .filter((e) => !Number.isNaN(e.at))
      .sort((a, b) => b.at - a.at),
  );

  const dayKey = (ms: number): string => new Date(ms).toDateString();

  function dayLabel(ms: number): string {
    const d = new Date(ms);
    const today = new Date();
    const yest = new Date();
    yest.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return t('activity.today');
    if (d.toDateString() === yest.toDateString()) return t('activity.yesterday');
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  // Group the flat, sorted event list into day buckets (preserves order).
  const groups = $derived.by(() => {
    const out: { key: string; label: string; items: Ev[] }[] = [];
    for (const e of events) {
      const k = dayKey(e.at);
      const last = out[out.length - 1];
      if (last !== undefined && last.key === k) last.items.push(e);
      else out.push({ key: k, label: dayLabel(e.at), items: [e] });
    }
    return out;
  });

  const time = (ms: number): string =>
    new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  // Map an execution status to a timeline dot kind.
  const kind = (status: string): string =>
    status === 'completed'
      ? 'ok'
      : status === 'failed'
        ? 'bad'
        : status === 'cancelled'
          ? 'muted'
          : 'live';
</script>

<header class="head">
  <h1>{t('nav.activity')}</h1>
  <p class="subtitle">{t('activity.subtitle')}</p>
</header>

{#if loading && runs.length === 0}
  <div class="state muted">{t('common.loading')}</div>
{:else if error !== null && runs.length === 0}
  <div class="state bad">{t('common.error')}: {error}</div>
{:else if events.length === 0}
  <div class="state muted">{t('activity.empty')}</div>
{:else}
  <div class="timeline">
    {#each groups as g (g.key)}
      <div class="day">
        <div class="day-label">{g.label}</div>
        <ul class="evs">
          {#each g.items as e (e.run.id + e.iso)}
            <li class="ev">
              <span class="rail">
                <span class="dot k-{kind(e.status)}" class:pulse={kind(e.status) === 'live'}></span>
              </span>
              <span class="time mono faint">{time(e.at)}</span>
              <a class="evtitle" href={`#/runs/${encodeURIComponent(e.run.id)}`}
                >{e.run.title || t('runs.col.run')}</a
              >
              {#if e.run.workItemId}
                <a class="task" href={`#/work-items/${encodeURIComponent(e.run.workItemId)}`}
                  >{e.run.workItemId}</a
                >
              {/if}
              <span class="grow"></span>
              {#if e.run.model}<span class="model faint">{e.run.model}</span>{/if}
              <span class="st st-{e.status}">{t('status.' + e.status)}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  </div>
{/if}

<style>
  .head {
    margin-bottom: 22px;
  }
  h1 {
    font-size: 24px;
  }
  .subtitle {
    color: var(--muted);
    font-size: 13px;
    margin-top: 4px;
  }
  .state {
    padding: 64px 0;
    text-align: center;
  }
  .timeline {
    display: flex;
    flex-direction: column;
    gap: 26px;
  }
  .day-label {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--faint);
    margin-bottom: 10px;
  }
  .evs {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .ev {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 12px 9px 0;
    position: relative;
  }
  /* The vertical rail: a hairline behind the dots connecting the day's events. */
  .rail {
    position: relative;
    width: 14px;
    flex-shrink: 0;
    align-self: stretch;
    display: flex;
    justify-content: center;
  }
  .rail::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--line);
  }
  .ev:first-child .rail::before {
    top: 50%;
  }
  .ev:last-child .rail::before {
    bottom: 50%;
  }
  .dot {
    position: relative;
    z-index: 1;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    margin-top: 5px;
    background: var(--faint);
    box-shadow: 0 0 0 3px var(--bg);
  }
  .dot.k-ok {
    background: var(--ok);
  }
  .dot.k-bad {
    background: var(--bad);
  }
  .dot.k-live {
    background: var(--accent);
    box-shadow:
      0 0 0 3px var(--bg),
      0 0 8px var(--accent);
  }
  .dot.k-muted {
    background: var(--faint);
  }
  .dot.pulse {
    animation: dotpulse 1.8s ease-in-out infinite;
  }
  @keyframes dotpulse {
    0%,
    100% {
      box-shadow:
        0 0 0 3px var(--bg),
        0 0 8px var(--accent);
    }
    50% {
      box-shadow:
        0 0 0 3px var(--bg),
        0 0 2px var(--accent);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot.pulse {
      animation: none;
    }
  }
  .time {
    font-size: 12px;
    width: 44px;
    flex-shrink: 0;
  }
  .evtitle {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 52%;
  }
  .evtitle:hover {
    color: var(--accent-2);
  }
  .task {
    font-family: var(--mono);
    font-size: 11px;
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--accent-soft);
    border: 1px solid rgba(77, 163, 255, 0.2);
    color: var(--accent-2);
    white-space: nowrap;
  }
  .grow {
    flex: 1;
  }
  .model {
    font-size: 11px;
    white-space: nowrap;
  }
  .st {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--panel-2);
    white-space: nowrap;
  }
  .st-completed {
    color: var(--ok);
  }
  .st-failed {
    color: var(--bad);
  }
  .st-running,
  .st-queued,
  .st-waiting_approval {
    color: var(--accent);
  }
  @media (max-width: 560px) {
    .model {
      display: none;
    }
    .evtitle {
      max-width: 40%;
    }
  }
</style>
