<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchRuns, ApiError } from '../lib/api';
  import type { RunRecord } from '../lib/contracts';
  import { t } from '../lib/i18n';

  let runs = $state<RunRecord[]>([]);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let filter = $state('');

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

  const filtered = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    if (q.length === 0) return runs;
    return runs.filter((r) =>
      [r.title, r.id, r.status, r.workflow, r.model ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  });

  const when = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  };

  // A non-color status differentiator (color alone fails a11y / colorblind users).
  const STATUS_GLYPH: Record<string, string> = {
    completed: '✓',
    failed: '✕',
    running: '▸',
    waiting_approval: '⏸',
    queued: '·',
    cancelled: '⊘',
  };
  const statusLabel = (s: string): string => t(`status.${s}`);
  const statusGlyph = (s: string): string => STATUS_GLYPH[s] ?? '•';
</script>

<header class="bar">
  <h1>{t('runs.title')} <span class="faint">({filtered.length})</span></h1>
  {#if runs.length > 0}
    <input class="input filter" type="search" placeholder={t('runs.filter')} bind:value={filter} />
  {/if}
</header>

{#if loading}
  <div class="state muted">{t('common.loading')}</div>
{:else if error !== null}
  <div class="state bad">{t('common.error')}: {error}</div>
{:else if runs.length === 0}
  <div class="state muted">{t('runs.empty')}</div>
{:else}
  <div class="scroll-x">
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
        {#each filtered as run (run.id)}
          <tr>
            <td><a class="mono" href={`#/runs/${run.id}`}>{run.title || run.id}</a></td>
            <td>
              <span class="st st-{run.status}" title={statusLabel(run.status)}>
                <span class="glyph" aria-hidden="true">{statusGlyph(run.status)}</span>
                {statusLabel(run.status)}
              </span>
            </td>
            <td class="faint">{run.workflow}</td>
            <td class="faint">{run.model ?? '—'}</td>
            <td class="faint">{when(run.startedAt)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 18px;
  }
  h1 {
    font-size: 22px;
  }
  .filter {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    color: var(--text);
    padding: 6px 12px;
    font: inherit;
    min-width: 240px;
  }
  .filter:focus {
    outline: none;
    border-color: var(--accent);
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
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--panel-2);
  }
  .glyph {
    font-size: 10px;
  }
  .st-completed {
    color: var(--ok);
  }
  .st-failed,
  .st-cancelled {
    color: var(--bad);
  }
  .st-running,
  .st-waiting_approval {
    color: var(--accent);
  }
</style>
