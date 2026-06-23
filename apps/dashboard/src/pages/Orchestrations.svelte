<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchOrchestrations, ApiError } from '../lib/api';
  import type { OrchestrationSummary } from '../lib/contracts';
  import { t } from '../lib/i18n';

  let orchestrations = $state<OrchestrationSummary[]>([]);
  let error = $state<string | null>(null);
  let loading = $state(true);

  async function load(): Promise<void> {
    try {
      const res = await fetchOrchestrations();
      orchestrations = res.orchestrations;
      error = null;
    } catch (e) {
      error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
    // Light polling keeps the multi-lane view live while a swarm runs (no SSE
    // dependency — the read surface is cheap). Cleared on unmount.
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  });

  const dollars = (cents: number | null): string =>
    cents === null ? '—' : `$${(cents / 100).toFixed(2)}`;

  function statusClass(status: string): string {
    if (status === 'completed') return 'ok';
    if (status === 'failed' || status === 'cancelled') return 'bad';
    if (status === 'running' || status === 'queued') return 'run';
    return 'idle';
  }
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
            <span class="title">{o.title}</span>
            <span class="count faint">{t('orch.lanes', { n: o.laneCount })}</span>
            <span class="grow"></span>
            <span class="status {statusClass(o.status)}">{o.status}</span>
          </header>
          <ul class="lanes">
            {#each o.lanes as lane (lane.runId)}
              <li>
                <span class="dot sm {statusClass(lane.status)}" aria-hidden="true"></span>
                <a href={`#/runs/${encodeURIComponent(lane.runId)}`} class="lane-title"
                  >{lane.title}</a
                >
                <span class="grow"></span>
                <span class="cost faint">{dollars(lane.costCents)}</span>
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
  .cost {
    font-variant-numeric: tabular-nums;
    font-size: 12px;
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
