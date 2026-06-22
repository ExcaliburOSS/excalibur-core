<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchPlans, fetchPlan, fetchDiscovery, ApiError } from '../lib/api';
  import type { PlanSummary, PlanDetail, DiscoverySummary } from '../lib/contracts';
  import { t } from '../lib/i18n';

  let plans = $state<PlanSummary[]>([]);
  let discovery = $state<DiscoverySummary[]>([]);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let openId = $state<string | null>(null);
  let openBody = $state<PlanDetail | null>(null);

  onMount(async () => {
    try {
      const [p, d] = await Promise.all([fetchPlans(), fetchDiscovery()]);
      plans = p.plans;
      discovery = d.discovery;
    } catch (e) {
      error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    } finally {
      loading = false;
    }
  });

  async function toggle(id: string): Promise<void> {
    if (openId === id) {
      openId = null;
      openBody = null;
      return;
    }
    openId = id;
    openBody = null;
    try {
      openBody = await fetchPlan(id);
    } catch {
      openBody = null;
    }
  }

  const when = (iso: string | null): string => {
    if (iso === null) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
  };
</script>

<h1>{t('plans.title')}</h1>

{#if loading}
  <div class="state muted">{t('common.loading')}</div>
{:else if error !== null}
  <div class="state bad">{t('common.error')}: {error}</div>
{:else}
  <div class="cols">
    <section>
      <h2>{t('plans.plans')} <span class="faint">({plans.length})</span></h2>
      {#if plans.length === 0}
        <div class="muted small">{t('plans.empty')}</div>
      {:else}
        <ul class="list">
          {#each plans as plan (plan.id)}
            <li class="item">
              <button class="row" onclick={() => toggle(plan.id)}>
                <span class="caret">{openId === plan.id ? '▾' : '▸'}</span>
                <span class="ttl">{plan.task}</span>
                <span class="st st-{plan.status}">{plan.status}</span>
                <span class="faint when">{when(plan.created)}</span>
              </button>
              {#if openId === plan.id}
                <pre class="body">{openBody ? openBody.body : t('common.loading')}</pre>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section>
      <h2>{t('plans.discovery')} <span class="faint">({discovery.length})</span></h2>
      {#if discovery.length === 0}
        <div class="muted small">{t('plans.discoveryEmpty')}</div>
      {:else}
        <ul class="list">
          {#each discovery as d (d.id)}
            <li class="dcard">
              <div class="drow">
                <span class="ttl">{d.title}</span>
                <span class="st st-{d.status}">{d.status}</span>
              </div>
              <div class="dmeta faint">
                {#if d.recommendation}<span class="rec">{d.recommendation}</span>{/if}
                {#if d.recommendedAutonomyLevel !== null}
                  <span>{t('plans.readiness', { level: d.recommendedAutonomyLevel })}</span>
                {/if}
                <span>{when(d.createdAt)}</span>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
{/if}

<style>
  h1 {
    font-size: 22px;
    margin-bottom: 18px;
  }
  .state {
    padding: 48px 0;
    text-align: center;
  }
  .cols {
    display: grid;
    grid-template-columns: 1.4fr 1fr;
    gap: 24px;
    align-items: start;
  }
  h2 {
    font-size: 15px;
    margin-bottom: 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--line);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    color: var(--text);
  }
  .row:hover {
    border-color: var(--line-strong);
  }
  .caret {
    color: var(--faint);
    width: 12px;
  }
  .ttl {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .when {
    font-size: 11px;
    white-space: nowrap;
  }
  .st {
    font-size: 10px;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--panel-2);
  }
  .st-executed,
  .st-completed {
    color: var(--ok);
  }
  .st-cancelled {
    color: var(--bad);
  }
  .st-approved,
  .st-open {
    color: var(--accent);
  }
  .body {
    margin: 4px 0 0;
    padding: 12px;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    font-family: var(--mono);
    font-size: 12px;
    white-space: pre-wrap;
    overflow-x: auto;
    max-height: 420px;
  }
  .dcard {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
  }
  .drow {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dmeta {
    display: flex;
    gap: 10px;
    font-size: 11px;
    margin-top: 4px;
    flex-wrap: wrap;
  }
  .rec {
    color: var(--accent);
  }
  .small {
    font-size: 12px;
  }
</style>
