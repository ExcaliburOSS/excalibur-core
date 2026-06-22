<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchWorkItem,
    fetchHealth,
    startRun,
    cancelRun,
    approveRun,
    ApiError,
  } from '../lib/api';
  import { type WorkItemDetail } from '../lib/contracts';
  import { navigate } from '../lib/router.svelte';
  import { t } from '../lib/i18n';

  const { key }: { key: string } = $props();

  let item = $state<WorkItemDetail | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let writable = $state(false);
  let actionError = $state<string | null>(null);

  onMount(() => {
    fetchHealth()
      .then((h) => (writable = h.write))
      .catch(() => (writable = false));
  });

  async function reload(): Promise<void> {
    try {
      item = await fetchWorkItem(key);
    } catch {
      /* keep current */
    }
  }

  async function act(fn: () => Promise<unknown>): Promise<void> {
    actionError = null;
    try {
      await fn();
      await reload();
    } catch (e) {
      actionError = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    }
  }

  async function onStartRun(): Promise<void> {
    if (item === null) return;
    actionError = null;
    try {
      const { runId } = await startRun({ task: item.title, workItemId: item.key });
      navigate(`/runs/${runId}`);
    } catch (e) {
      actionError = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    }
  }

  // Re-fetch whenever `key` changes — the component instance is REUSED when
  // navigating WI-1 → WI-2 (same route branch), so onMount alone would show
  // stale data. An incrementing token discards out-of-order responses.
  let token = 0;
  $effect(() => {
    const k = key;
    const mine = ++token;
    loading = true;
    error = null;
    item = null;
    fetchWorkItem(k)
      .then((d) => {
        if (mine === token) item = d;
      })
      .catch((e: unknown) => {
        if (mine === token) error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
      })
      .finally(() => {
        if (mine === token) loading = false;
      });
  });

  // Defense in depth: the server already sanitizes link URLs, but guard the href
  // here too so a script-bearing scheme can never reach the DOM.
  const safeHref = (url: string): string => {
    const c = url.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
    if (/^(https?:|mailto:)/i.test(c)) return c;
    if (c.startsWith('#')) return c;
    if (c.startsWith('/') && !c.startsWith('//')) return c;
    return '#';
  };
</script>

<a class="back" href="#/">← {t('workItem.back')}</a>

{#if loading}
  <div class="state muted">{t('common.loading')}</div>
{:else if error !== null || item === null}
  <div class="state bad">{t('workItem.none', { key })}</div>
{:else}
  <header class="head">
    <div class="key mono faint">{item.key}</div>
    <h1>{item.title}</h1>
    <div class="badges">
      <span class="lane">{t('lane.' + item.lane)}</span>
      {#if item.priority}<span class="badge">{item.priority}</span>{/if}
      {#if item.assignee}<span class="badge">@{item.assignee}</span>{/if}
      {#each item.labels as label (label)}<span class="badge">{label}</span>{/each}
    </div>
    {#if writable}
      <div class="actions">
        <button class="act go" onclick={onStartRun}>▸ {t('workItem.startRun')}</button>
      </div>
    {/if}
  </header>

  {#if actionError !== null}
    <div class="action-error" role="status">{t('workItem.actionFailed')}: {actionError}</div>
  {/if}

  {#if item.description}
    <p class="desc">{item.description}</p>
  {/if}

  <section>
    <h2>{t('workItem.runs')} <span class="faint">({item.runs.length})</span></h2>
    {#if item.runs.length === 0}
      <div class="muted small">—</div>
    {:else}
      <ul class="runs">
        {#each item.runs as run (run.id)}
          <li>
            <a class="mono" href={`#/runs/${run.id}`}>{run.id}</a>
            <span class="st st-{run.status}">{t('status.' + run.status)}</span>
            <span class="faint">{run.workflow}{run.model ? ` · ${run.model}` : ''}</span>
            {#if writable && run.status === 'running'}
              <button class="act" onclick={() => act(() => cancelRun(run.id))}>
                {t('workItem.cancelRun')}
              </button>
            {:else if writable && run.status === 'waiting_approval'}
              <button class="act go" onclick={() => act(() => approveRun(run.id, true))}>
                {t('workItem.approve')}
              </button>
              <button class="act no" onclick={() => act(() => approveRun(run.id, false))}>
                {t('workItem.reject')}
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if item.links.length > 0}
    <section>
      <h2>{t('workItem.links')}</h2>
      <ul class="links">
        {#each item.links as link (link.url)}
          <li><a href={safeHref(link.url)} target="_blank" rel="noreferrer">{link.title ?? link.url}</a>
            <span class="faint small">{link.type}</span></li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if item.comments.length > 0}
    <section>
      <h2>{t('workItem.comments')}</h2>
      <ul class="comments">
        {#each item.comments as c, i (i)}
          <li><span class="faint">{c.author ?? '—'}</span> {c.body}</li>
        {/each}
      </ul>
    </section>
  {/if}
{/if}

<style>
  .back {
    display: inline-block;
    margin-bottom: 16px;
    color: var(--muted);
    font-size: 13px;
  }
  .state {
    padding: 48px 0;
    text-align: center;
  }
  .head .key {
    font-size: 12px;
  }
  .head h1 {
    margin: 4px 0 12px;
    font-size: 24px;
  }
  .badges {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .lane,
  .badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--panel-2);
    border: 1px solid var(--line);
  }
  .lane {
    background: var(--accent-dim);
  }
  .desc {
    color: var(--muted);
    max-width: 70ch;
    white-space: pre-wrap;
  }
  section {
    margin-top: 28px;
  }
  h2 {
    font-size: 15px;
    margin-bottom: 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--line);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .runs li {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .actions {
    margin-top: 12px;
  }
  .act {
    font-size: 11px;
    padding: 3px 10px;
    border-radius: var(--radius-sm);
    background: var(--panel-2);
    border: 1px solid var(--line);
    color: var(--muted);
  }
  .act:hover {
    color: var(--text);
    border-color: var(--line-strong);
  }
  .act.go {
    color: var(--ok);
    border-color: color-mix(in srgb, var(--ok) 40%, var(--line));
  }
  .act.no {
    color: var(--bad);
    border-color: color-mix(in srgb, var(--bad) 40%, var(--line));
  }
  .action-error {
    margin: 12px 0;
    padding: 6px 12px;
    border: 1px solid color-mix(in srgb, var(--bad) 40%, var(--line));
    background: color-mix(in srgb, var(--bad) 10%, transparent);
    color: var(--bad);
    border-radius: var(--radius-sm);
    font-size: 12px;
  }
  .st {
    font-size: 11px;
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
  .small {
    font-size: 12px;
  }
</style>
