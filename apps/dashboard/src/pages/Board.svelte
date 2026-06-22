<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchBoard, ApiError } from '../lib/api';
  import { LANES, LANE_LABELS, LANE_COLORS, type BoardResponse } from '../lib/contracts';
  import { t } from '../lib/i18n';

  let board = $state<BoardResponse | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);

  onMount(async () => {
    try {
      board = await fetchBoard();
    } catch (e) {
      error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    } finally {
      loading = false;
    }
  });

  const laneItems = (lane: string) =>
    board?.lanes.find((l) => l.lane === lane)?.items ?? [];

  const total = $derived(board?.lanes.reduce((n, l) => n + l.items.length, 0) ?? 0);
</script>

{#if loading}
  <div class="state muted">{t('common.loading')}</div>
{:else if error !== null}
  <div class="state bad">{t('common.error')}: {error}</div>
{:else if total === 0}
  <div class="state muted">{t('board.empty')}</div>
{:else}
  <div class="board">
    {#each LANES as lane (lane)}
      {@const items = laneItems(lane)}
      <section class="lane">
        <header style="--lane: {LANE_COLORS[lane]}">
          <span class="dot"></span>
          <h3>{LANE_LABELS[lane]}</h3>
          <span class="count faint">{items.length}</span>
        </header>
        <div class="cards">
          {#each items as item (item.key)}
            <a class="card" href={`#/work-items/${item.key}`}>
              <div class="key mono faint">{item.key}</div>
              <div class="title">{item.title}</div>
              <div class="meta">
                {#if item.labels.length > 0}
                  <span class="labels">
                    {#each item.labels.slice(0, 3) as label (label)}
                      <span class="label">{label}</span>
                    {/each}
                  </span>
                {/if}
                {#if item.runCount > 0}
                  <span class="runs faint">{t('board.runs', { n: item.runCount })}</span>
                {/if}
              </div>
            </a>
          {/each}
        </div>
      </section>
    {/each}
  </div>
{/if}

<style>
  .state {
    padding: 64px 0;
    text-align: center;
  }
  .board {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 14px;
    align-items: start;
  }
  .lane {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    min-height: 120px;
  }
  .lane > header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--line);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--lane);
  }
  .lane h3 {
    font-size: 13px;
    flex: 1;
  }
  .count {
    font-size: 12px;
  }
  .cards {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
  }
  .card {
    display: block;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    color: var(--text);
  }
  .card:hover {
    border-color: var(--line-strong);
    text-decoration: none;
  }
  .key {
    font-size: 11px;
  }
  .title {
    margin: 2px 0 8px;
    font-weight: 500;
    line-height: 1.35;
  }
  .meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .labels {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .label {
    font-size: 10px;
    background: var(--accent-dim);
    color: var(--text);
    padding: 1px 6px;
    border-radius: 999px;
  }
  .runs {
    font-size: 11px;
    white-space: nowrap;
  }
</style>
