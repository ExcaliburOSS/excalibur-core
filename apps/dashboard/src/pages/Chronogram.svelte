<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { fetchChronogram, fetchHealth, pauseOrchestration, authToken, ApiError } from '../lib/api';
  import type { ChronogramDto, ChronogramLaneDto, ChronogramLaneState } from '../lib/contracts';
  import { navigate } from '../lib/router.svelte';
  import { t } from '../lib/i18n';

  // The parent (swarm) run id from the route (`#/orchestrations/:id`).
  let { id }: { id: string } = $props();

  let chronogram = $state<ChronogramDto | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let live = $state(false);
  let writable = $state(false);
  let toggling = $state(false);
  // A ticking clock so a still-running lane's bar grows toward "now".
  let nowTick = $state(Date.now());

  let es: EventSource | null = null;
  let reconnect: ReturnType<typeof setTimeout> | null = null;
  let clock: ReturnType<typeof setInterval> | null = null;

  async function load(): Promise<void> {
    try {
      chronogram = await fetchChronogram(id);
      error = null;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) error = t('chrono.notFound');
      else error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    } finally {
      loading = false;
    }
  }

  /** Live chronogram via SSE — the server pushes a snapshot only when it changes. */
  function connect(): void {
    if (es !== null || typeof EventSource === 'undefined') return;
    const url = `/api/orchestrations/${encodeURIComponent(id)}/stream?token=${encodeURIComponent(authToken())}`;
    const stream = new EventSource(url);
    stream.addEventListener('orchestration', (ev) => {
      try {
        chronogram = JSON.parse((ev as MessageEvent).data) as ChronogramDto;
        loading = false;
        error = null;
      } catch {
        /* ignore a malformed frame */
      }
    });
    stream.onopen = () => (live = true);
    stream.onerror = () => {
      stream.close();
      es = null;
      live = false;
      scheduleReconnect();
    };
    es = stream;
  }

  function scheduleReconnect(): void {
    if (reconnect !== null) return;
    reconnect = setTimeout(() => {
      reconnect = null;
      if (es === null) connect();
    }, 5000);
  }

  async function togglePause(): Promise<void> {
    if (chronogram === null || toggling) return;
    toggling = true;
    const next = !chronogram.paused;
    try {
      await pauseOrchestration(id, next);
      // Optimistic — SSE will confirm with the authoritative snapshot.
      chronogram = { ...chronogram, paused: next };
    } catch {
      /* leave the prior state; the next snapshot corrects it */
    } finally {
      toggling = false;
    }
  }

  onMount(() => {
    void load();
    connect();
    fetchHealth()
      .then((h) => (writable = h.write))
      .catch(() => (writable = false));
    clock = setInterval(() => (nowTick = Date.now()), 1000);
  });
  onDestroy(() => {
    es?.close();
    if (reconnect !== null) clearTimeout(reconnect);
    if (clock !== null) clearInterval(clock);
  });

  const dollars = (cents: number | null): string =>
    cents === null ? '—' : `$${(cents / 100).toFixed(2)}`;

  function fmtElapsed(ms: number | null): string {
    if (ms === null) return '';
    if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
  }

  function stateClass(state: ChronogramLaneState): string {
    switch (state) {
      case 'done':
        return 'ok';
      case 'failed':
        return 'bad';
      case 'running':
        return 'run';
      case 'empty':
        return 'empty';
      case 'cancelled':
        return 'cancelled';
      default:
        return 'pending';
    }
  }

  interface LaneGeo extends ChronogramLaneDto {
    hasBar: boolean;
    left: number;
    width: number;
    elapsedMs: number | null;
  }

  // The shared time axis: t0 = earliest lane start, t1 = latest end (or now for a
  // still-running lane). Each lane bar is positioned/sized against that span — a
  // real chronogram (time on x), grouped by dependency wave.
  const geo = $derived.by((): LaneGeo[] => {
    const c = chronogram;
    if (c === null) return [];
    const starts: number[] = [];
    const ends: number[] = [];
    for (const lane of c.lanes) {
      const s = lane.startedAt !== null ? Date.parse(lane.startedAt) : null;
      if (s !== null && !Number.isNaN(s)) {
        starts.push(s);
        const e =
          lane.completedAt !== null
            ? Date.parse(lane.completedAt)
            : lane.state === 'running'
              ? nowTick
              : s;
        if (!Number.isNaN(e)) ends.push(e);
      }
    }
    const t0 = starts.length > 0 ? Math.min(...starts) : 0;
    const t1 = ends.length > 0 ? Math.max(...ends) : t0 + 1;
    const span = Math.max(1, t1 - t0);
    return c.lanes.map((lane): LaneGeo => {
      const s = lane.startedAt !== null ? Date.parse(lane.startedAt) : null;
      const hasBar = s !== null && !Number.isNaN(s);
      const e =
        lane.completedAt !== null
          ? Date.parse(lane.completedAt)
          : lane.state === 'running' && hasBar
            ? nowTick
            : s;
      const left = hasBar ? ((s! - t0) / span) * 100 : 0;
      const width = hasBar && e !== null ? Math.max(2.5, ((e - s!) / span) * 100) : 0;
      const elapsedMs =
        lane.durationMs !== null
          ? lane.durationMs
          : lane.state === 'running' && hasBar
            ? Math.max(0, nowTick - s!)
            : null;
      return { ...lane, hasBar, left, width, elapsedMs };
    });
  });

  const byId = $derived(new Map(geo.map((l) => [l.id, l])));
  const titleOf = (laneId: string): string => byId.get(laneId)?.title ?? laneId;

  function tally(state: ChronogramLaneState): number {
    return (chronogram?.lanes ?? []).filter((l) => l.state === state).length;
  }
</script>

<section>
  <a class="back faint" href="#/orchestrations">{t('chrono.back')}</a>

  {#if loading && chronogram === null}
    <div class="empty">{t('common.loading')}</div>
  {:else if error !== null}
    <div class="empty err">{error}</div>
  {:else if chronogram !== null}
    <header class="head">
      <h1>{chronogram.task}</h1>
      <div class="meta faint">
        {#if chronogram.paused}
          <span class="badge paused">{t('chrono.paused')}</span>
        {:else}
          <span class="badge {stateClass(chronogram.status as ChronogramLaneState)}"
            >{chronogram.status}</span
          >
        {/if}
        <span class="mode">{chronogram.mode}</span>
        {#if chronogram.totalCostCents !== null}<span>{dollars(chronogram.totalCostCents)}</span>{/if}
        {#if live}<span class="livedot" title={t('chrono.live')}></span>{/if}
        {#if writable}
          <button class="pausebtn" type="button" disabled={toggling} onclick={togglePause}>
            {chronogram.paused ? t('chrono.resume') : t('chrono.pause')}
          </button>
        {/if}
      </div>
    </header>

    <div class="waves">
      {#each chronogram.waves as wave, w (w)}
        <div class="wave">
          <div class="wave-label faint">{t('chrono.wave', { n: w + 1 })}</div>
          <div class="tracks">
            {#each wave as laneId (laneId)}
              {@const lane = byId.get(laneId)}
              {#if lane}
                <button
                  class="track"
                  type="button"
                  disabled={lane.runId === null}
                  onclick={() => lane.runId && navigate(`/runs/${lane.runId}`)}
                  title={lane.instruction}
                >
                  <span class="lane-name">{lane.title}</span>
                  <span class="rail">
                    {#if lane.hasBar}
                      <span
                        class="bar {stateClass(lane.state)}"
                        class:pulse={lane.state === 'running'}
                        style={`left:${lane.left}%;width:${lane.width}%`}
                      ></span>
                    {:else}
                      <span class="bar pending placeholder" style="left:0;width:6%"></span>
                    {/if}
                  </span>
                  <span class="lane-stats faint">
                    {#if lane.elapsedMs !== null}<span>{fmtElapsed(lane.elapsedMs)}</span>{/if}
                    {#if lane.costCents !== null && lane.costCents > 0}<span
                        >{dollars(lane.costCents)}</span
                      >{/if}
                  </span>
                  {#if lane.dependsOn.length > 0}
                    <span class="dep faint"
                      >{t('chrono.depends', {
                        deps: lane.dependsOn.map(titleOf).join(', '),
                      })}</span
                    >
                  {/if}
                </button>
              {/if}
            {/each}
          </div>
        </div>
      {/each}
    </div>

    <footer class="summary faint">
      <span class="ok">{t('chrono.done', { n: tally('done') })}</span>
      {#if tally('running') > 0}<span class="run">{t('chrono.running', { n: tally('running') })}</span
        >{/if}
      {#if tally('failed') > 0}<span class="bad">{t('chrono.failed', { n: tally('failed') })}</span
        >{/if}
      {#if tally('pending') > 0}<span>{t('chrono.pending', { n: tally('pending') })}</span>{/if}
    </footer>
  {/if}
</section>

<style>
  .back {
    display: inline-block;
    margin-bottom: 14px;
    font-size: 13px;
    color: var(--accent);
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 18px;
  }
  h1 {
    margin: 0;
    font-size: 20px;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
  }
  .badge {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--line);
  }
  .badge.paused {
    color: var(--warn);
    border-color: var(--warn);
  }
  .mode {
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .pausebtn {
    font: inherit;
    font-size: 12px;
    padding: 3px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--line-strong);
    background: var(--panel-2);
    color: var(--text);
    cursor: pointer;
  }
  .pausebtn:hover:not(:disabled) {
    border-color: var(--accent);
  }
  .pausebtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .livedot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    animation: blink 1.4s ease-in-out infinite;
  }
  .waves {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .wave {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--panel);
    padding: 10px 14px;
  }
  .wave-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 8px;
  }
  .tracks {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .track {
    display: grid;
    grid-template-columns: 180px 1fr auto;
    align-items: center;
    gap: 12px;
    width: 100%;
    background: none;
    border: 0;
    padding: 5px 6px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
    color: var(--text);
    font: inherit;
  }
  .track:hover:not(:disabled) {
    background: var(--panel-2);
  }
  .track:disabled {
    cursor: default;
  }
  .lane-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }
  .rail {
    position: relative;
    height: 14px;
    background: var(--panel-2);
    border-radius: 7px;
    overflow: hidden;
  }
  .bar {
    position: absolute;
    top: 0;
    bottom: 0;
    border-radius: 7px;
    min-width: 4px;
    background: var(--muted);
  }
  .bar.ok {
    background: var(--ok);
  }
  .bar.bad {
    background: var(--bad);
  }
  .bar.run {
    background: var(--accent);
  }
  .bar.empty {
    background: var(--line-strong);
  }
  .bar.cancelled {
    background: var(--faint);
  }
  .bar.pending {
    background: var(--line-strong);
  }
  .bar.placeholder {
    opacity: 0.4;
  }
  .bar.pulse {
    animation: pulse 1.4s ease-in-out infinite;
  }
  .lane-stats {
    display: flex;
    gap: 8px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    grid-column: 3;
  }
  .dep {
    grid-column: 2 / 4;
    font-size: 11px;
  }
  .summary {
    display: flex;
    gap: 14px;
    margin-top: 18px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .ok {
    color: var(--ok);
  }
  .bad {
    color: var(--bad);
  }
  .run {
    color: var(--accent);
  }
  .empty {
    padding: 56px 0;
    text-align: center;
    color: var(--muted);
  }
  .empty.err {
    color: var(--bad);
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.55;
    }
  }
  @keyframes blink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .bar.pulse,
    .livedot {
      animation: none;
    }
  }
</style>
