<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchOrchestrations,
    fetchHealth,
    cancelOrchestrationLane,
    authToken,
    ApiError,
  } from '../lib/api';
  import type { OrchestrationSummary } from '../lib/contracts';
  import { t } from '../lib/i18n';

  let orchestrations = $state<OrchestrationSummary[]>([]);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let writable = $state(false); // per-lane cancel needs serve --write
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let reconnect: ReturnType<typeof setTimeout> | null = null;

  async function load(quiet = false): Promise<void> {
    if (!quiet) loading = true;
    try {
      const res = await fetchOrchestrations();
      orchestrations = res.orchestrations;
      error = null;
    } catch (e) {
      if (orchestrations.length === 0) {
        error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
      }
    } finally {
      loading = false;
    }
  }

  // AO4e-3 — live list via SSE: the server pushes a new snapshot only when it
  // changes (a lane finished, a swarm started, a lane was cancelled). Replaces the
  // old 3s poll; falls back to polling + reconnect if the stream drops.
  function connect(): void {
    if (es !== null || typeof EventSource === 'undefined') return;
    const stream = new EventSource(
      `/api/orchestrations/stream?token=${encodeURIComponent(authToken())}`,
    );
    stream.addEventListener('orchestrations', (ev) => {
      try {
        orchestrations = (
          JSON.parse((ev as MessageEvent).data) as { orchestrations: OrchestrationSummary[] }
        ).orchestrations;
        loading = false;
        error = null;
      } catch {
        /* ignore a malformed frame */
      }
    });
    stream.onopen = () => stopPoll();
    stream.onerror = () => {
      stream.close();
      es = null;
      startPoll();
      scheduleReconnect();
    };
    es = stream;
  }
  function scheduleReconnect(): void {
    if (reconnect !== null) return;
    reconnect = setTimeout(() => {
      reconnect = null;
      if (es === null) connect();
    }, 5000);
  }
  function startPoll(): void {
    if (timer !== null) return;
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 4000);
  }
  function stopPoll(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function cancelLane(parentId: string, runId: string): Promise<void> {
    try {
      await cancelOrchestrationLane(parentId, runId);
      void load(true);
    } catch (e) {
      error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    }
  }

  onMount(() => {
    void load();
    fetchHealth()
      .then((h) => (writable = h.write))
      .catch(() => {
        /* read-only share link — leave write off */
      });
    connect();
    return () => {
      es?.close();
      es = null;
      stopPoll();
      if (reconnect !== null) clearTimeout(reconnect);
    };
  });

  const dollars = (cents: number | null): string =>
    cents === null ? '—' : `$${(cents / 100).toFixed(2)}`;

  function statusClass(status: string): string {
    if (status === 'completed') return 'ok';
    if (status === 'failed' || status === 'cancelled') return 'bad';
    if (status === 'running' || status === 'queued') return 'run';
    return 'idle';
  }
  const laneActive = (status: string): boolean => status === 'running' || status === 'queued';
</script>

<section>
  <h1>{t('orch.title')}</h1>
  <p class="sub faint">{t('orch.subtitle')}</p>

  {#if loading && orchestrations.length === 0}
    <div class="empty">{t('common.loading')}</div>
  {:else if error !== null}
    <div class="empty err">{error}</div>
  {:else if orchestrations.length === 0}
    <div class="empty">{t('orch.none')}</div>
  {:else}
    <div class="list">
      {#each orchestrations as o (o.parentRunId)}
        <article class="orch">
          <header>
            <span class="dot {statusClass(o.status)}" aria-hidden="true"></span>
            <a class="title" href={`#/orchestrations/${encodeURIComponent(o.parentRunId)}`}
              >{o.title}</a
            >
            <span class="count faint">{t('orch.lanes', { n: o.laneCount })}</span>
            <span class="grow"></span>
            <a
              class="chrono-link faint"
              href={`#/orchestrations/${encodeURIComponent(o.parentRunId)}`}>{t('orch.chronogram')}</a
            >
            <span class="status {statusClass(o.status)}">{o.status}</span>
          </header>
          <ul class="lanes">
            {#each o.lanes as lane (lane.runId)}
              <li>
                <span class="dot sm {statusClass(lane.status)}" aria-hidden="true"></span>
                <a href={`#/runs/${encodeURIComponent(lane.runId)}`} class="lane-title"
                  >{lane.title}</a
                >
                {#if lane.workItemId}
                  <a class="wi" href={`#/work-items/${encodeURIComponent(lane.workItemId)}`}
                    >{lane.workItemId}</a
                  >
                {/if}
                <span class="grow"></span>
                <span class="cost faint">{dollars(lane.costCents)}</span>
                {#if writable && laneActive(lane.status)}
                  <button class="cancel" onclick={() => cancelLane(o.parentRunId, lane.runId)}
                    >{t('orch.cancel-lane')}</button
                  >
                {/if}
                <span class="lane-status {statusClass(lane.status)}">{lane.status}</span>
              </li>
            {/each}
          </ul>
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  h1 {
    margin: 0 0 2px;
  }
  .sub {
    margin: 0 0 20px;
    font-size: 13px;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .orch {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--panel);
    overflow: hidden;
  }
  .orch > header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--line);
    background: var(--panel-2);
  }
  .title {
    font-weight: 600;
    color: var(--text);
  }
  .chrono-link {
    font-size: 12px;
    color: var(--accent);
  }
  .count {
    font-size: 12px;
  }
  .grow {
    flex: 1;
  }
  .lanes {
    list-style: none;
    margin: 0;
    padding: 4px 0;
  }
  .lanes li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 16px;
  }
  .lanes li + li {
    border-top: 1px solid var(--line);
  }
  .lane-title {
    color: var(--text);
  }
  .wi {
    font-size: 11px;
    color: var(--accent);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0 5px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .cost {
    font-variant-numeric: tabular-nums;
    font-size: 12px;
  }
  .cancel {
    font: inherit;
    font-size: 11px;
    color: var(--bad, #f85149);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 1px 7px;
    cursor: pointer;
  }
  .cancel:hover {
    border-color: var(--bad, #f85149);
  }
  .status,
  .lane-status {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--muted);
    flex: none;
  }
  .dot.sm {
    width: 7px;
    height: 7px;
  }
  .ok {
    color: var(--ok, #3fb950);
  }
  .dot.ok {
    background: var(--ok, #3fb950);
  }
  .bad {
    color: var(--bad, #f85149);
  }
  .dot.bad {
    background: var(--bad, #f85149);
  }
  .run {
    color: var(--accent);
  }
  .dot.run {
    background: var(--accent);
  }
  .empty {
    padding: 56px 0;
    text-align: center;
    color: var(--muted);
  }
  .empty.err {
    color: var(--bad, #f85149);
  }
</style>
