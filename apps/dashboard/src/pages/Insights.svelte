<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchInsights, ApiError } from '../lib/api';
  import type { InsightsReportDto, CountCostDto } from '../lib/contracts';
  import { t } from '../lib/i18n';

  let report = $state<InsightsReportDto | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);

  onMount(async () => {
    try {
      report = await fetchInsights();
    } catch (e) {
      error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    } finally {
      loading = false;
    }
  });

  const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
  const compact = (n: number): string =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
  const pct = (n: number): string => `${Math.round(n * 100)}%`;

  // Last 14 day buckets for the time-series.
  const days = $derived((report?.byDay ?? []).slice(-14));
  const maxDayCost = $derived(Math.max(1, ...days.map((d) => d.costCents)));
  const maxRowCost = (rows: CountCostDto[]): number => Math.max(1, ...rows.map((r) => r.costCents));
</script>

<h1>{t('insights.title')}</h1>

{#if loading}
  <div class="state muted">{t('common.loading')}</div>
{:else if error !== null}
  <div class="state bad">{t('common.error')}: {error}</div>
{:else if report === null || report.totalRuns === 0}
  <div class="state muted">{t('insights.empty')}</div>
{:else}
  <div class="stats">
    <div class="stat">
      <div class="v">{report.totalRuns}</div>
      <div class="k faint">{t('insights.runs')}</div>
    </div>
    <div class="stat">
      <div class="v">{money(report.totalCostCents)}</div>
      <div class="k faint">{t('insights.cost')}</div>
    </div>
    <div class="stat">
      <div class="v">{compact(report.totalInputTokens + report.totalOutputTokens)}</div>
      <div class="k faint">
        {t('insights.tokens')}
        <span class="sub"
          >{compact(report.totalInputTokens)} {t('insights.in')} · {compact(
            report.totalOutputTokens,
          )} {t('insights.out')}</span
        >
      </div>
    </div>
    <div class="stat">
      <div class="v">{pct(report.completionRate)}</div>
      <div class="k faint">{t('insights.completion')}</div>
    </div>
  </div>

  {#if days.length > 0}
    <section>
      <h2>{t('insights.byDay')}</h2>
      <div class="chart" role="img" aria-label={t('insights.byDay')}>
        {#each days as d (d.day)}
          <div class="bar-col" title={`${d.day}: ${money(d.costCents)} (${d.runs})`}>
            <div class="bar" style="height: {(d.costCents / maxDayCost) * 100}%"></div>
            <div class="xlabel faint">{d.day.slice(5)}</div>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <div class="cols">
    {#each [{ title: t('insights.byModel'), rows: report.byModel }, { title: t('insights.byWorkflow'), rows: report.byWorkflow }] as group (group.title)}
      <section>
        <h2>{group.title}</h2>
        {#if group.rows.length === 0}
          <div class="muted small">—</div>
        {:else}
          {@const max = maxRowCost(group.rows)}
          <ul class="rows">
            {#each group.rows as row (row.key)}
              <li class="brow">
                <span class="rk mono">{row.key}</span>
                <span class="track"><span class="fill" style="width: {(row.costCents / max) * 100}%"></span></span>
                <span class="rv faint">{money(row.costCents)} · {row.runs}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
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
  .stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
    margin-bottom: 24px;
  }
  .stat {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 16px;
  }
  .stat .v {
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .stat .k {
    font-size: 12px;
    margin-top: 4px;
  }
  .sub {
    display: block;
    font-size: 10px;
    margin-top: 2px;
  }
  section {
    margin-bottom: 24px;
  }
  h2 {
    font-size: 15px;
    margin-bottom: 12px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--line);
  }
  .chart {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    height: 160px;
    padding: 8px 0;
  }
  .bar-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    height: 100%;
    gap: 4px;
  }
  .bar {
    width: 100%;
    max-width: 28px;
    background: var(--accent);
    border-radius: 3px 3px 0 0;
    min-height: 2px;
  }
  .xlabel {
    font-size: 9px;
  }
  .cols {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
    align-items: start;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .brow {
    display: grid;
    grid-template-columns: 1fr 2fr auto;
    gap: 10px;
    align-items: center;
    font-size: 12px;
  }
  .rk {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .track {
    height: 8px;
    background: var(--line);
    border-radius: 999px;
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .rv {
    white-space: nowrap;
    font-size: 11px;
  }
  .small {
    font-size: 12px;
  }
  @media (prefers-reduced-motion: reduce) {
    .bar,
    .fill {
      transition: none;
    }
  }
</style>
