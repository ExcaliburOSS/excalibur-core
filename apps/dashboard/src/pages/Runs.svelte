<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchRuns, ApiError } from '../lib/api';
  import type { RunSummary } from '../lib/contracts';
  import { t } from '../lib/i18n';

  let runs = $state<RunSummary[]>([]);
  let error = $state<string | null>(null);
  let loading = $state(true);

  onMount(async () => {
    try {
      const res = await fetchRuns();
      runs = res.runs;
    } catch (e) {
      error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    } finally {
      loading = false;
    }
  });

  const when = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  };
</script>

<h1>{t('runs.title')} <span class="faint">({runs.length})</span></h1>

{#if loading}
  <div class="state muted">{t('common.loading')}</div>
{:else if error !== null}
  <div class="state bad">{t('common.error')}: {error}</div>
{:else if runs.length === 0}
  <div class="state muted">{t('runs.empty')}</div>
{:else}
  <table>
    <thead>
      <tr>
        <th>{t('runs.col.run')}</th>
        <th>{t('runs.col.status')}</th>
        <th>{t('runs.col.workflow')}</th>
        <th>{t('runs.col.model')}</th>
        <th>{t('runs.col.started')}</th>
      </tr>
    </thead>
    <tbody>
      {#each runs as run (run.id)}
        <tr>
          <td><a class="mono" href={`#/runs/${run.id}`}>{run.title || run.id}</a></td>
          <td><span class="st st-{run.status}">{run.status}</span></td>
          <td class="faint">{run.workflow}</td>
          <td class="faint">{run.model ?? '—'}</td>
          <td class="faint">{when(run.startedAt)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
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
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th {
    text-align: left;
    color: var(--muted);
    font-weight: 500;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
  }
  td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
  }
  tr:hover td {
    background: var(--panel);
  }
  .st {
    font-size: 11px;
    padding: 1px 8px;
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
</style>
