<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchWorkItem, ApiError } from '../lib/api';
  import { LANE_LABELS, type WorkItemDetail } from '../lib/contracts';
  import { t } from '../lib/i18n';

  const { key }: { key: string } = $props();

  let item = $state<WorkItemDetail | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);

  onMount(async () => {
    try {
      item = await fetchWorkItem(key);
    } catch (e) {
      error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    } finally {
      loading = false;
    }
  });
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
      <span class="lane">{LANE_LABELS[item.lane]}</span>
      {#if item.priority}<span class="badge">{item.priority}</span>{/if}
      {#if item.assignee}<span class="badge">@{item.assignee}</span>{/if}
      {#each item.labels as label (label)}<span class="badge">{label}</span>{/each}
    </div>
  </header>

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
            <span class="st st-{run.status}">{run.status}</span>
            <span class="faint">{run.workflow}{run.model ? ` · ${run.model}` : ''}</span>
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
          <li><a href={link.url} target="_blank" rel="noreferrer">{link.title ?? link.url}</a>
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
