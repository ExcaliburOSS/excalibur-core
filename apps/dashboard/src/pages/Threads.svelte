<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchThreads, ApiError } from '../lib/api';
  import type { BackgroundThreadView } from '../lib/contracts';
  import { t } from '../lib/i18n';

  // DASH3 — the background `/bg` fleet, a read-only projection of the run store
  // (workflow conversation-bg). Each thread is a recorded run, so it links to the
  // run detail. Re-polls every 4s so live threads update.
  let threads = $state<BackgroundThreadView[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function load(): Promise<void> {
    try {
      threads = (await fetchThreads()).threads;
      error = null;
    } catch (e) {
      error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    }
  }

  onMount(() => {
    void load().finally(() => (loading = false));
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  });

  const running = $derived(threads.filter((th) => th.status === 'running').length);
  const when = (iso: string | null): string => {
    if (iso === null) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  };
</script>

<h1>{t('threads.title')}</h1>
<p class="subtitle">{t('threads.subtitle')}</p>

{#if error !== null}
  <div class="state bad small">{error}</div>
{/if}

{#if loading}
  <div class="state muted">{t('common.loading')}</div>
{:else if threads.length === 0}
  <div class="muted small">{t('threads.empty')}</div>
{:else}
  <div class="count faint">{t('threads.running', { n: running })}</div>
  <ul class="list">
    {#each threads as th (th.id)}
      <li class="thread thread-{th.status}">
        <a class="row" href={`#/runs/${encodeURIComponent(th.id)}`}>
          <span class="dot dot-{th.status}" aria-hidden="true"></span>
          <span class="ttl">{th.title}</span>
          <span class="st st-{th.status}">{t('status.' + th.status)}</span>
          {#if th.model}<span class="faint model">{th.model}</span>{/if}
          <span class="faint when">{t('threads.started')} {when(th.startedAt)}</span>
        </a>
      </li>
    {/each}
  </ul>
{/if}

<style>
  h1 {
    font-size: 22px;
    margin-bottom: 4px;
  }
  .subtitle {
    color: var(--muted);
    margin: 0 0 18px;
    font-size: 13px;
  }
  .state {
    padding: 24px 0;
  }
  .state.muted {
    text-align: center;
    padding: 48px 0;
  }
  .count {
    font-size: 11px;
    margin-bottom: 10px;
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
    gap: 10px;
    width: 100%;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
    color: var(--text);
  }
  .row:hover {
    border-color: var(--line-strong);
    text-decoration: none;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
    flex-shrink: 0;
  }
  .dot-running {
    background: var(--accent);
  }
  .dot-completed {
    background: var(--ok);
  }
  .dot-failed {
    background: var(--bad);
  }
  .ttl {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .model,
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
  .st-completed {
    color: var(--ok);
  }
  .st-failed {
    color: var(--bad);
  }
  .st-running {
    color: var(--accent);
  }
  .small {
    font-size: 12px;
  }
  .state.bad {
    color: var(--bad);
  }
</style>
