<script lang="ts">
  import { fetchSprints, fetchSprint, ApiError } from '../lib/api';
  import type { SprintSummary, SprintDetail, BurndownPointDto } from '../lib/contracts';
  import { t } from '../lib/i18n';

  // `id` empty → the sprint list; `id` set → one sprint's detail (with burndown).
  const { id = '' }: { id?: string } = $props();

  let sprints = $state<SprintSummary[]>([]);
  let detail = $state<SprintDetail | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);

  let token = 0;
  $effect(() => {
    const sid = id;
    const mine = ++token;
    loading = true;
    error = null;
    detail = null;
    const job =
      sid.length > 0
        ? fetchSprint(sid).then((d) => {
            if (mine === token) detail = d;
          })
        : fetchSprints().then((r) => {
            if (mine === token) sprints = r.sprints;
          });
    job
      .catch((e: unknown) => {
        if (mine === token)
          error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
      })
      .finally(() => {
        if (mine === token) loading = false;
      });
  });

  const pct = (done: number, total: number): number =>
    total === 0 ? 0 : Math.round((done / total) * 100);

  const statusGlyph = (s: SprintSummary['status']): string =>
    s === 'active' ? '▸' : s === 'completed' ? '✓' : '○';

  // --- Burndown SVG geometry (no chart lib; inverted y so points read upward) ---
  const CHART = { w: 680, h: 220, padL: 36, padR: 12, padT: 14, padB: 26 };
  const plotW = CHART.w - CHART.padL - CHART.padR;
  const plotH = CHART.h - CHART.padT - CHART.padB;

  function maxY(days: BurndownPointDto[]): number {
    return Math.max(1, ...days.map((d) => Math.max(d.ideal, d.remaining)));
  }
  function xAt(i: number, n: number): number {
    return CHART.padL + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  }
  function yAt(value: number, max: number): number {
    return CHART.padT + (1 - value / max) * plotH;
  }
  function line(days: BurndownPointDto[], pick: (d: BurndownPointDto) => number): string {
    const max = maxY(days);
    return days.map((d, i) => `${xAt(i, days.length)},${yAt(pick(d), max)}`).join(' ');
  }
</script>

{#if id.length > 0}
  <!-- Detail -->
  <a class="back" href="#/sprints">{t('sprints.back')}</a>
  {#if loading}
    <div class="state muted">{t('common.loading')}</div>
  {:else if error !== null || detail === null}
    <div class="state bad">{t('common.notFound')}</div>
  {:else}
    <header class="dhead">
      <h1>{detail.name}</h1>
      <div class="dmeta">
        <span class="st st-{detail.status}">{t('sprint.status.' + detail.status)}</span>
        <span class="faint">{detail.startDate} → {detail.endDate}</span>
        <span class="faint pts">{t('sprint.points', { done: detail.donePoints, total: detail.totalPoints })}</span>
      </div>
      {#if detail.goal}<p class="goal">{detail.goal}</p>{/if}
    </header>

    {#if detail.burndown.length > 0}
      <section class="chart">
        <div class="clabel">
          {t('sprint.burndown')}
          <span class="legend"><span class="dot ideal"></span>{t('sprint.ideal')}</span>
          <span class="legend"><span class="dot actual"></span>{t('sprint.actual')}</span>
        </div>
        <svg viewBox={`0 0 ${CHART.w} ${CHART.h}`} class="svg" role="img" aria-label={t('sprint.burndown')}>
          <!-- baseline -->
          <line
            x1={CHART.padL}
            y1={CHART.padT + plotH}
            x2={CHART.w - CHART.padR}
            y2={CHART.padT + plotH}
            class="axis"
          />
          <polyline points={line(detail.burndown, (d) => d.ideal)} class="ideal" />
          <polyline points={line(detail.burndown, (d) => d.remaining)} class="actual" />
        </svg>
      </section>
    {/if}

    <section>
      <h2>{t('sprint.workItems')} <span class="faint">({detail.items.length})</span></h2>
      {#if detail.items.length === 0}
        <div class="state muted small">{t('sprint.noItems')}</div>
      {:else}
        <ul class="items">
          {#each detail.items as item (item.key)}
            <li>
              <a class="row" href={`#/work-items/${encodeURIComponent(item.key)}`}>
                <span class="lane lane-{item.lane}">{t('lane.' + item.lane)}</span>
                <span class="mono key">{item.key}</span>
                <span class="ttl">{item.title}</span>
                <span class="chev faint">›</span>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
{:else}
  <!-- List -->
  <header class="bar">
    <h1>{t('sprints.title')} <span class="faint count">{sprints.length}</span></h1>
  </header>
  {#if loading}
    <div class="state muted">{t('common.loading')}</div>
  {:else if error !== null}
    <div class="state bad">{t('common.error')}: {error}</div>
  {:else if sprints.length === 0}
    <div class="state muted"><p>{t('sprints.empty')}</p></div>
  {:else}
    <ul class="list">
      {#each sprints as s (s.id)}
        <li>
          <a class="srow" href={`#/sprints/${encodeURIComponent(s.id)}`}>
            <span class="st st-{s.status}">{statusGlyph(s.status)} {t('sprint.status.' + s.status)}</span>
            <span class="sname">{s.name}</span>
            <span class="faint win">{s.startDate} → {s.endDate}</span>
            <span class="prog">
              <span class="track"><span class="fill" style={`width:${pct(s.donePoints, s.totalPoints)}%`}></span></span>
              <span class="faint mono num">{s.donePoints}/{s.totalPoints}</span>
            </span>
            <span class="faint items-n">{t('sprint.items', { n: s.itemCount })}</span>
            <span class="chev faint">›</span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 18px;
  }
  h1 {
    font-size: 24px;
  }
  .count {
    font-family: var(--mono);
    font-size: 14px;
    color: var(--muted);
    margin-left: 6px;
  }
  .state {
    padding: 56px 0;
    text-align: center;
  }
  .state.small {
    padding: 24px 0;
  }
  .state.bad {
    color: var(--bad);
  }
  .list,
  .items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .srow,
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    background: linear-gradient(180deg, var(--panel-2), var(--panel));
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 13px 16px;
    color: var(--text);
    box-shadow: var(--shadow-1);
    transition:
      border-color var(--transition),
      transform var(--transition);
  }
  .srow:hover,
  .row:hover {
    border-color: var(--accent-dim);
    transform: translateY(-2px);
    text-decoration: none;
  }
  .sname,
  .ttl {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .win,
  .items-n {
    font-size: 11px;
    white-space: nowrap;
  }
  .prog {
    display: flex;
    align-items: center;
    gap: 7px;
    white-space: nowrap;
  }
  .track {
    width: 70px;
    height: 6px;
    border-radius: 999px;
    background: var(--panel-2);
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: linear-gradient(90deg, var(--accent-dim), var(--accent));
  }
  .num {
    font-size: 11px;
  }
  .chev {
    font-size: 18px;
    line-height: 1;
  }
  .st {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--panel-2);
    white-space: nowrap;
  }
  .st-active {
    color: var(--accent);
  }
  .st-completed {
    color: var(--ok);
  }
  /* Detail */
  .back {
    display: inline-block;
    margin-bottom: 16px;
    color: var(--muted);
    font-size: 13px;
  }
  .dhead h1 {
    margin-bottom: 8px;
  }
  .dmeta {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 6px;
  }
  .pts {
    font-family: var(--mono);
  }
  .goal {
    color: var(--muted);
    margin: 4px 0 18px;
  }
  .chart {
    margin: 8px 0 24px;
  }
  .clabel,
  .clabel + * {
    font-size: 12px;
  }
  .clabel {
    color: var(--muted);
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .legend {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .dot {
    width: 10px;
    height: 3px;
    border-radius: 2px;
    display: inline-block;
  }
  .dot.ideal {
    background: var(--muted);
  }
  .dot.actual {
    background: var(--accent);
  }
  .svg {
    width: 100%;
    height: auto;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius);
  }
  .axis {
    stroke: var(--line);
    stroke-width: 1;
  }
  .ideal {
    fill: none;
    stroke: var(--muted);
    stroke-width: 1.5;
    stroke-dasharray: 4 3;
  }
  .actual {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2;
  }
  .lane {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-2);
    white-space: nowrap;
  }
  .key {
    font-size: 12px;
    color: var(--accent);
  }
  h2 {
    font-size: 15px;
    margin: 0 0 10px;
  }
</style>
