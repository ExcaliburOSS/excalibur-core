<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fetchInsights, ApiError } from '../lib/api';
  import type { InsightsReportDto, CountCostDto } from '../lib/contracts';
  import { t } from '../lib/i18n';

  let report = $state<InsightsReportDto | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let timer: ReturnType<typeof setInterval> | null = null;

  async function load(quiet = false): Promise<void> {
    if (!quiet) loading = true;
    try {
      report = await fetchInsights();
      error = null;
    } catch (e) {
      if (report === null) error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 8000);
  });
  onDestroy(() => {
    if (timer !== null) clearInterval(timer);
  });

  const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
  const compact = (n: number): string =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  const humanize = (s: string): string =>
    s.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const has = $derived(report !== null && report.totalRuns > 0);

  // --- Evolution chart (cost area + executions bars over the last 30 days) ----
  const W = 640;
  const H = 150;
  const days = $derived((report?.byDay ?? []).slice(-30));
  const maxCost = $derived(Math.max(1, ...days.map((d) => d.costCents)));
  const maxRuns = $derived(Math.max(1, ...days.map((d) => d.runs)));
  const px = (i: number): number => (days.length <= 1 ? W / 2 : (i / (days.length - 1)) * W);

  const linePath = $derived.by(() => {
    if (days.length === 0) return '';
    return days
      .map((d, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${(H - (d.costCents / maxCost) * H).toFixed(1)}`)
      .join(' ');
  });
  const areaPath = $derived.by(() => {
    if (days.length === 0) return '';
    return `M0,${H} ${linePath.replace(/^M/, 'L')} L${W},${H} Z`;
  });

  // --- Outcome donut (byStatus) ---------------------------------------------
  const statusColor = (k: string): string =>
    k === 'completed'
      ? 'var(--ok)'
      : k === 'failed'
        ? 'var(--bad)'
        : k === 'cancelled'
          ? 'var(--faint)'
          : 'var(--accent)';

  const statusEntries = $derived(
    Object.entries(report?.byStatus ?? {})
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]),
  );
  const statusTotal = $derived(statusEntries.reduce((s, [, n]) => s + n, 0));
  const donut = $derived.by(() => {
    if (statusTotal === 0) return 'var(--line)';
    let acc = 0;
    const segs = statusEntries.map(([k, n]) => {
      const start = (acc / statusTotal) * 360;
      acc += n;
      const end = (acc / statusTotal) * 360;
      return `${statusColor(k)} ${start.toFixed(1)}deg ${end.toFixed(1)}deg`;
    });
    return `conic-gradient(${segs.join(', ')})`;
  });

  const maxRowCost = (rows: CountCostDto[]): number => Math.max(1, ...rows.map((r) => r.costCents));
</script>

<h1>{t('insights.title')}</h1>

{#if loading && report === null}
  <div class="state muted">{t('common.loading')}</div>
{:else if error !== null && report === null}
  <div class="state bad">{t('common.error')}: {error}</div>
{:else}
  <!-- Aggregated KPIs (always shown; zeros when there's no data yet). -->
  <div class="kpis">
    <div class="kpi">
      <div class="v">{report?.totalRuns ?? 0}</div>
      <div class="k">{t('insights.runs')}</div>
    </div>
    <div class="kpi">
      <div class="v">{money(report?.totalCostCents ?? 0)}</div>
      <div class="k">{t('insights.cost')}</div>
    </div>
    <div class="kpi">
      <div class="v">{pct(report?.completionRate ?? 0)}</div>
      <div class="k">{t('insights.completion')}</div>
    </div>
    <div class="kpi">
      <div class="v">{compact((report?.totalInputTokens ?? 0) + (report?.totalOutputTokens ?? 0))}</div>
      <div class="k">
        {t('insights.tokens')}
        <span class="sub"
          >{compact(report?.totalInputTokens ?? 0)} {t('insights.in')} · {compact(
            report?.totalOutputTokens ?? 0,
          )} {t('insights.out')}</span
        >
      </div>
    </div>
  </div>

  <div class="kpis secondary">
    <div class="kpi sm">
      <div class="v">{money(report?.avgCostCentsPerRun ?? 0)}</div>
      <div class="k">{t('insights.avgCost')}</div>
    </div>
    <div class="kpi sm">
      <div class="v">{report?.totalFilesChanged ?? 0}</div>
      <div class="k">{t('insights.files')}</div>
    </div>
    <div class="kpi sm">
      <div class="v">{report?.totalModelCalls ?? 0}</div>
      <div class="k">{t('insights.calls')}</div>
    </div>
    <div class="kpi sm">
      <div class="v">{report?.totalApprovals ?? 0}</div>
      <div class="k">{t('insights.approvals')}</div>
    </div>
  </div>

  <!-- Evolution over time -->
  <section class="card chartcard">
    <header class="ch">
      <h2>{t('insights.evolution')}</h2>
      <div class="legend">
        <span class="lg"><span class="sw line"></span>{t('insights.cost')}</span>
        <span class="lg"><span class="sw bar"></span>{t('insights.runs')}</span>
      </div>
    </header>
    {#if has && days.length > 0}
      <svg class="area" viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="img" aria-label={t('insights.evolution')}>
        <defs>
          <linearGradient id="costfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.35" />
            <stop offset="100%" stop-color="var(--accent)" stop-opacity="0" />
          </linearGradient>
        </defs>
        {#each days as d, i (d.day)}
          <rect
            x={px(i) - 6}
            y={H - (d.runs / maxRuns) * H}
            width="12"
            height={(d.runs / maxRuns) * H}
            fill="var(--line-strong)"
            opacity="0.4"
          ></rect>
        {/each}
        <path d={areaPath} fill="url(#costfill)"></path>
        <path d={linePath} fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"></path>
      </svg>
      <div class="axis faint">
        <span>{days[0]?.day.slice(5)}</span>
        <span>{days[days.length - 1]?.day.slice(5)}</span>
      </div>
    {:else}
      <div class="placeholder">{t('insights.noData')}</div>
    {/if}
  </section>

  <div class="cols">
    <!-- Outcome donut -->
    <section class="card">
      <h2>{t('insights.byStatus')}</h2>
      {#if statusTotal > 0}
        <div class="donutwrap">
          <div class="donut" style="background: {donut}">
            <div class="hole">
              <span class="dt">{statusTotal}</span>
              <span class="dl faint">{t('insights.runs')}</span>
            </div>
          </div>
          <ul class="legend2">
            {#each statusEntries as [k, n] (k)}
              <li>
                <span class="sw2" style="background: {statusColor(k)}"></span>
                <span class="lk">{t('status.' + k)}</span>
                <span class="ln faint">{n} · {pct(n / statusTotal)}</span>
              </li>
            {/each}
          </ul>
        </div>
      {:else}
        <div class="placeholder">{t('insights.noData')}</div>
      {/if}
    </section>

    <!-- By model -->
    <section class="card">
      <h2>{t('insights.byModel')}</h2>
      {#if (report?.byModel.length ?? 0) > 0}
        {@const rows = report?.byModel ?? []}
        {@const max = maxRowCost(rows)}
        <ul class="rows">
          {#each rows as row (row.key)}
            <li class="brow">
              <span class="rk mono" title={row.key}>{row.key}</span>
              <span class="track"
                ><span class="fill" style="width: {(row.costCents / max) * 100}%"></span></span
              >
              <span class="rv faint">{money(row.costCents)} · {row.runs}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <div class="placeholder">{t('insights.noData')}</div>
      {/if}
    </section>
  </div>

  <!-- By type -->
  <section class="card">
    <h2>{t('insights.byWorkflow')}</h2>
    {#if (report?.byWorkflow.length ?? 0) > 0}
      {@const rows = report?.byWorkflow ?? []}
      {@const max = maxRowCost(rows)}
      <ul class="rows">
        {#each rows as row (row.key)}
          <li class="brow">
            <span class="rk">{humanize(row.key)}</span>
            <span class="track"
              ><span class="fill alt" style="width: {(row.costCents / max) * 100}%"></span></span
            >
            <span class="rv faint">{money(row.costCents)} · {row.runs}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <div class="placeholder">{t('insights.noData')}</div>
    {/if}
  </section>
{/if}

<style>
  h1 {
    font-size: 24px;
    margin-bottom: 20px;
  }
  .state {
    padding: 56px 0;
    text-align: center;
  }
  .kpis {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
    margin-bottom: 14px;
  }
  .secondary {
    margin-bottom: 26px;
  }
  .kpi {
    background: linear-gradient(180deg, var(--panel-2), var(--panel));
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 16px 18px;
    box-shadow: var(--shadow-1), var(--inset-top);
  }
  .kpi .v {
    font-size: 28px;
    font-weight: 650;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }
  .kpi.sm .v {
    font-size: 20px;
  }
  .kpi .k {
    font-size: 12px;
    color: var(--muted);
    margin-top: 4px;
  }
  .sub {
    display: block;
    font-size: 10px;
    color: var(--faint);
    margin-top: 2px;
  }
  .card {
    background: linear-gradient(180deg, var(--panel-2), var(--panel));
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 16px 18px;
    box-shadow: var(--shadow-1), var(--inset-top);
    margin-bottom: 18px;
  }
  h2 {
    font-size: 14px;
    margin: 0 0 14px;
  }
  .ch {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .ch h2 {
    margin: 0;
  }
  .legend {
    display: flex;
    gap: 14px;
    font-size: 11px;
    color: var(--muted);
  }
  .lg {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .sw {
    width: 12px;
    height: 3px;
    border-radius: 2px;
  }
  .sw.line {
    background: var(--accent);
  }
  .sw.bar {
    height: 10px;
    width: 8px;
    background: var(--line-strong);
    border-radius: 2px;
  }
  .area {
    width: 100%;
    height: 150px;
    display: block;
    margin-top: 12px;
    overflow: visible;
  }
  .axis {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    margin-top: 6px;
  }
  .placeholder {
    height: 140px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--faint);
    font-size: 13px;
    border: 1px dashed var(--line);
    border-radius: var(--radius-sm);
    background: repeating-linear-gradient(
      45deg,
      transparent,
      transparent 8px,
      rgba(120, 150, 190, 0.03) 8px,
      rgba(120, 150, 190, 0.03) 16px
    );
  }
  .cols {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 18px;
    align-items: start;
  }
  .donutwrap {
    display: flex;
    align-items: center;
    gap: 22px;
  }
  .donut {
    width: 128px;
    height: 128px;
    border-radius: 50%;
    flex-shrink: 0;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .hole {
    width: 78px;
    height: 78px;
    border-radius: 50%;
    background: var(--panel);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .dt {
    font-size: 24px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
  }
  .dl {
    font-size: 10px;
  }
  .legend2 {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
  }
  .legend2 li {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }
  .sw2 {
    width: 10px;
    height: 10px;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .lk {
    flex: 1;
  }
  .ln {
    font-size: 11px;
    white-space: nowrap;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .brow {
    display: grid;
    grid-template-columns: 1.1fr 2fr auto;
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
    background: linear-gradient(90deg, var(--accent-dim), var(--accent));
    border-radius: 999px;
  }
  .fill.alt {
    background: linear-gradient(90deg, var(--accent-dim), var(--accent-2));
  }
  .rv {
    white-space: nowrap;
    font-size: 11px;
  }
  @media (max-width: 720px) {
    .kpis {
      grid-template-columns: repeat(2, 1fr);
    }
    .cols {
      grid-template-columns: 1fr;
    }
  }
</style>
