<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchMissions,
    fetchMission,
    ApiError,
    type MissionListItemView,
    type MissionDetailView,
  } from '../lib/api';
  import { t } from '../lib/i18n';

  let missions = $state<MissionListItemView[]>([]);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let openId = $state<string | null>(null);
  let openBody = $state<MissionDetailView | null>(null);

  onMount(async () => {
    try {
      missions = (await fetchMissions()).missions;
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
      openBody = await fetchMission(id);
    } catch {
      openBody = null;
    }
  }

  const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
  // ✓ done · ◐ running · ○ pending · ✗ failed · ⊘ skipped — mirrors the TUI ribbon.
  const stepGlyph = (status: string): string =>
    status === 'done'
      ? '✓'
      : status === 'running'
        ? '◐'
        : status === 'failed'
          ? '✗'
          : status === 'skipped'
            ? '⊘'
            : '○';
</script>

<h1>{t('nav.missions')}</h1>
<p class="sub faint">{t('missions.subtitle')}</p>

{#if loading}
  <div class="state muted">{t('common.loading')}</div>
{:else if error !== null}
  <div class="state bad">{t('common.error')}: {error}</div>
{:else if missions.length === 0}
  <div class="state muted">{t('missions.empty')}</div>
{:else}
  <ul class="list">
    {#each missions as m (m.id)}
      <li class="item">
        <button class="row" onclick={() => toggle(m.id)}>
          <span class="caret">{openId === m.id ? '▾' : '▸'}</span>
          <span class="ttl">{m.goal}</span>
          <span class="prog faint">{m.stepsDone}/{m.stepsTotal}</span>
          {#if m.spentCents > 0}<span class="cost faint">{dollars(m.spentCents)}</span>{/if}
          <span class="st st-{m.outcome}">{m.outcome}</span>
        </button>
        {#if openId === m.id}
          {#if openBody === null}
            <div class="body muted small">{t('common.loading')}</div>
          {:else}
            <div class="detail">
              <div class="meta faint">
                <span>{openBody.complexity}</span>
                <span>risk: {openBody.risk}</span>
                {#if openBody.pausedReason}<span class="paused">paused: {openBody.pausedReason}</span
                  >{/if}
              </div>
              <ul class="dag">
                {#each openBody.steps as s (s.id)}
                  <li class="step st-{s.status}">
                    <span class="sg">{stepGlyph(s.status)}</span>
                    <span class="cap">{s.capability}</span>
                    {#if s.gate}<span class="gate">gate</span>{/if}
                    {#if s.attempts > 1}<span class="retry">↻{s.attempts}</span>{/if}
                    <span class="obj faint">{s.objective}</span>
                  </li>
                {/each}
              </ul>
              {#if openBody.successCriteria.length > 0}
                <div class="crit">
                  <span class="clabel faint">{t('missions.criteria')}</span>
                  <ul>
                    {#each openBody.successCriteria as c (c)}
                      <li>{c}</li>
                    {/each}
                  </ul>
                </div>
              {/if}
            </div>
          {/if}
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  h1 {
    font-size: 22px;
    margin-bottom: 4px;
  }
  .sub {
    margin: 0 0 18px;
    font-size: 13px;
  }
  .state {
    padding: 48px 0;
    text-align: center;
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
  .prog,
  .cost {
    font-size: 11px;
    white-space: nowrap;
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
  .st-failed,
  .st-aborted {
    color: var(--bad);
  }
  .st-paused {
    color: var(--accent);
  }
  .detail {
    margin: 4px 0 0;
    padding: 12px;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }
  .meta {
    display: flex;
    gap: 12px;
    font-size: 11px;
    margin-bottom: 8px;
  }
  .paused {
    color: var(--accent);
  }
  .dag {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .step {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 13px;
  }
  .sg {
    width: 12px;
    color: var(--muted);
  }
  .step.st-done .sg {
    color: var(--ok);
  }
  .step.st-failed .sg {
    color: var(--bad);
  }
  .step.st-running .sg {
    color: var(--accent);
  }
  .cap {
    font-weight: 500;
    min-width: 96px;
  }
  .gate {
    font-size: 10px;
    color: var(--accent);
  }
  .retry {
    font-size: 10px;
    color: var(--accent);
  }
  .obj {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }
  .crit {
    margin-top: 10px;
    font-size: 12px;
  }
  .clabel {
    font-size: 11px;
  }
  .crit ul {
    margin: 4px 0 0;
    padding-left: 18px;
  }
  .small {
    font-size: 12px;
  }
</style>
