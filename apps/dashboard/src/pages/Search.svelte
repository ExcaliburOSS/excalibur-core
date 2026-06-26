<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchRuns, fetchBoard, ApiError } from '../lib/api';
  import type { RunRecord, WorkItemSummary } from '../lib/contracts';
  import { t } from '../lib/i18n';

  // DASH5 — global search across runs + work items. Client-side over the existing
  // /api/runs + /api/board projections (no new endpoint); a single query filters
  // both by their searchable fields.
  let runs = $state<RunRecord[]>([]);
  let items = $state<WorkItemSummary[]>([]);
  let query = $state('');
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(async () => {
    // Seed from the top-bar search (`#/search?q=…`) so a query typed up there
    // lands here pre-filled instead of an empty box.
    const seeded = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('q');
    if (seeded !== null && seeded.length > 0) query = seeded;
    try {
      const [r, b] = await Promise.all([fetchRuns(), fetchBoard()]);
      runs = r.runs;
      items = b.lanes.flatMap((l) => l.items);
    } catch (e) {
      error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    } finally {
      loading = false;
    }
  });

  const q = $derived(query.trim().toLowerCase());
  const matchedRuns = $derived(
    q.length === 0
      ? []
      : runs.filter((r) =>
          [r.title, r.id, r.workflow, r.model ?? '', r.status]
            .join(' ')
            .toLowerCase()
            .includes(q),
        ),
  );
  const matchedItems = $derived(
    q.length === 0
      ? []
      : items.filter((it) =>
          [it.key, it.title, it.assignee ?? '', it.lane, ...it.labels]
            .join(' ')
            .toLowerCase()
            .includes(q),
        ),
  );
  const hasResults = $derived(matchedRuns.length > 0 || matchedItems.length > 0);

  const when = (iso: string | null): string => {
    if (iso === null) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
  };
</script>

<h1>{t('search.title')}</h1>
<input class="q" bind:value={query} placeholder={t('search.placeholder')} />

{#if loading}
  <div class="state muted">{t('common.loading')}</div>
{:else if error !== null}
  <div class="state bad">{t('common.error')}: {error}</div>
{:else if q.length === 0}
  <div class="muted small hint">{t('search.prompt')}</div>
{:else if !hasResults}
  <div class="muted small hint">{t('search.noResults', { q: query.trim() })}</div>
{:else}
  {#if matchedItems.length > 0}
    <h2>{t('search.workItems')} <span class="faint">({matchedItems.length})</span></h2>
    <ul class="list">
      {#each matchedItems as it (it.key)}
        <li>
          <a class="row" href={`#/work-items/${encodeURIComponent(it.key)}`}>
            <span class="key mono">{it.key}</span>
            <span class="ttl">{it.title}</span>
            <span class="lane faint">{t('lane.' + it.lane)}</span>
            {#each it.labels as lbl (lbl)}<span class="label">{lbl}</span>{/each}
            {#if it.assignee}<span class="faint who">{it.assignee}</span>{/if}
          </a>
        </li>
      {/each}
    </ul>
  {/if}

  {#if matchedRuns.length > 0}
    <h2>{t('search.runs')} <span class="faint">({matchedRuns.length})</span></h2>
    <ul class="list">
      {#each matchedRuns as r (r.id)}
        <li>
          <a class="row" href={`#/runs/${encodeURIComponent(r.id)}`}>
            <span class="st st-{r.status}">{t('status.' + r.status)}</span>
            <span class="ttl">{r.title || r.id}</span>
            <span class="faint wf">{r.workflow}</span>
            {#if r.model}<span class="faint who">{r.model}</span>{/if}
            <span class="faint when">{when(r.startedAt)}</span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
{/if}

<style>
  h1 {
    font-size: 22px;
    margin-bottom: 12px;
  }
  h2 {
    font-size: 15px;
    margin: 20px 0 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--line);
  }
  .q {
    width: 100%;
    box-sizing: border-box;
    background: var(--panel-2);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    color: var(--text);
    padding: 10px 12px;
    font: inherit;
    font-size: 15px;
  }
  .q:focus {
    outline: none;
    border-color: var(--accent);
  }
  .state {
    padding: 40px 0;
    text-align: center;
  }
  .hint {
    margin-top: 16px;
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
  .mono {
    font-family: var(--mono);
    font-size: 12px;
  }
  .ttl {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lane,
  .wf,
  .who,
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
  .label {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--panel-2);
    color: var(--muted);
  }
  .small {
    font-size: 12px;
  }
  .state.bad {
    color: var(--bad);
  }
</style>
