<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fetchBoard, fetchHealth, moveWorkItem, startRun, authToken, ApiError } from '../lib/api';
  import {
    LANES,
    LANE_COLORS,
    type BoardResponse,
    type DashboardLane,
    type WorkItemSummary,
  } from '../lib/contracts';
  import { navigate } from '../lib/router.svelte';
  import { t } from '../lib/i18n';

  let board = $state<BoardResponse | null>(null);
  let error = $state<string | null>(null);
  /** A poll that failed AFTER we already had data — surfaced non-destructively. */
  let staleError = $state<string | null>(null);
  let loading = $state(true);
  let live = $state(true);
  let writable = $state(false); // interactive actions enabled (serve --write)
  let dragKey = $state<string | null>(null);
  let dropLane = $state<DashboardLane | null>(null);
  let copied = $state(false);
  let inFlight = false; // guards against overlapping/clobbering polls
  let timer: ReturnType<typeof setInterval> | null = null;
  let es: EventSource | null = null;

  /** Refresh the board; quiet (no spinner) on the auto-poll path. */
  async function load(quiet = false): Promise<void> {
    if (inFlight) return; // a request is already running — don't stack/clobber
    inFlight = true;
    if (!quiet) loading = true;
    try {
      board = await fetchBoard();
      error = null;
      staleError = null;
    } catch (e) {
      const msg = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
      // Keep the last good board on a background poll failure; only blow away the
      // view when we have nothing to show.
      if (board === null) error = msg;
      else staleError = msg;
    } finally {
      loading = false;
      inFlight = false;
    }
  }

  /** Live board via SSE — the server pushes a new snapshot only when it changes. */
  function connect(): void {
    if (es !== null || typeof EventSource === 'undefined') return;
    const stream = new EventSource(`/api/board/stream?token=${encodeURIComponent(authToken())}`);
    stream.addEventListener('board', (ev) => {
      // Don't clobber an in-progress drag/optimistic move with a server snapshot.
      if (dragKey !== null || inFlight) return;
      try {
        board = JSON.parse((ev as MessageEvent).data) as BoardResponse;
        loading = false;
        error = null;
        staleError = null;
      } catch {
        /* ignore a malformed frame */
      }
    });
    stream.onerror = () => {
      // SSE dropped — fall back to a periodic poll until reconnected.
      stream.close();
      es = null;
      startPoll();
    };
    es = stream;
  }

  function startPoll(): void {
    if (timer !== null) return;
    timer = setInterval(() => {
      if (live && !dragKey && document.visibilityState === 'visible') void load(true);
    }, 4000);
  }
  function stopPoll(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function goLive(on: boolean): void {
    live = on;
    if (on) {
      void load(true);
      connect();
    } else {
      es?.close();
      es = null;
      stopPoll();
    }
  }

  onMount(() => {
    void load();
    fetchHealth()
      .then((h) => (writable = h.write))
      .catch(() => (writable = false));
    connect(); // SSE primary; startPoll() is the fallback on error
  });
  onDestroy(() => {
    stopPoll();
    es?.close();
  });

  const laneLabel = (lane: string): string => t(`lane.${lane}`);

  /** Optimistically move a card to a lane, then persist; revert (reload) on failure. */
  async function moveTo(key: string, lane: DashboardLane): Promise<void> {
    if (board === null) return;
    let card: WorkItemSummary | undefined;
    for (const col of board.lanes) {
      const idx = col.items.findIndex((i) => i.key === key);
      if (idx >= 0) {
        if (col.lane === lane) return; // dropped on its own lane — no-op
        card = col.items.splice(idx, 1)[0];
        break;
      }
    }
    if (card === undefined) return;
    card.lane = lane;
    board.lanes.find((l) => l.lane === lane)?.items.push(card);
    try {
      const updated = await moveWorkItem(key, lane);
      const target = board.lanes.find((l) => l.lane === lane);
      const i = target?.items.findIndex((c) => c.key === key) ?? -1;
      if (target && i >= 0) target.items[i] = updated; // reconcile with server truth
    } catch (e) {
      staleError = e instanceof ApiError ? `${e.status} · ${e.message}` : t('board.moveFailed', { key });
      void load(); // revert the optimistic move to server state
    }
  }

  function onDrop(e: DragEvent, lane: DashboardLane): void {
    e.preventDefault();
    const key = dragKey ?? e.dataTransfer?.getData('text/plain') ?? '';
    dragKey = null;
    dropLane = null;
    if (key.length > 0) void moveTo(key, lane);
  }

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(window.location.href);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  async function onStartRun(e: MouseEvent, item: WorkItemSummary): Promise<void> {
    e.preventDefault();
    e.stopPropagation();
    try {
      const { runId } = await startRun({ task: item.title, workItemId: item.key });
      navigate(`/runs/${runId}`);
    } catch (err) {
      staleError = err instanceof ApiError ? `${err.status} · ${err.message}` : String(err);
    }
  }

  const laneItems = (lane: string): WorkItemSummary[] =>
    board?.lanes.find((l) => l.lane === lane)?.items ?? [];

  const total = $derived(board?.lanes.reduce((n, l) => n + l.items.length, 0) ?? 0);
  const activeCount = $derived(
    board?.lanes.reduce((n, l) => n + l.items.filter((i) => i.activeRunId !== null).length, 0) ?? 0,
  );

  const doneCount = (item: WorkItemSummary): number =>
    item.checklist.filter((c) => c.status === 'completed').length;
</script>

<header class="bar">
  <div class="left">
    <h1>{t('nav.board')}</h1>
    {#if total > 0}<span class="faint count">{total}</span>{/if}
    {#if activeCount > 0}
      <span class="active-pill"><span class="pulse"></span>{activeCount} {t('board.active')}</span>
    {/if}
  </div>
  <div class="right">
    <button class="toggle" class:on={live} onclick={() => goLive(!live)} title="Live updates">
      <span class="dot" class:pulse={live}></span>
      {live ? t('board.live') : t('board.paused')}
    </button>
    <button class="refresh" onclick={() => load()}>{t('board.refresh')}</button>
    <button class="refresh" onclick={copyLink}>{copied ? t('board.copied') : t('board.share')}</button>
  </div>
</header>

{#if staleError !== null}
  <div class="stale" role="status">{t('common.error')}: {staleError}</div>
{/if}

{#if loading && board === null}
  <div class="state muted">{t('common.loading')}</div>
{:else if error !== null && board === null}
  <div class="state bad">{t('common.error')}: {error}</div>
{:else if total === 0}
  <div class="state muted">{t('board.empty')}</div>
{:else}
  <div class="board">
    {#each LANES as lane (lane)}
      {@const items = laneItems(lane)}
      <section class="lane" class:dropping={writable && dropLane === lane}>
        <header style="--lane: {LANE_COLORS[lane]}">
          <span class="ldot"></span>
          <h3>{laneLabel(lane)}</h3>
          <span class="lcount faint">{items.length}</span>
        </header>
        <div
          class="cards"
          role="list"
          ondragover={writable
            ? (e) => {
                e.preventDefault();
                dropLane = lane;
              }
            : undefined}
          ondrop={writable ? (e) => onDrop(e, lane) : undefined}
        >
          {#each items as item (item.key)}
            <a
              class="card"
              class:active={item.activeRunId !== null}
              class:dragging={dragKey === item.key}
              href={`#/work-items/${item.key}`}
              draggable={writable}
              ondragstart={writable
                ? (e) => {
                    dragKey = item.key;
                    e.dataTransfer?.setData('text/plain', item.key);
                  }
                : undefined}
              ondragend={() => {
                dragKey = null;
                dropLane = null;
              }}
            >
              <div class="top">
                <span class="key mono faint">{item.key}</span>
                {#if item.activeRunId !== null}
                  <span class="running"><span class="pulse"></span>{t('board.active')}</span>
                {:else if writable}
                  <button class="start" onclick={(e) => onStartRun(e, item)}>
                    ▸ {t('board.startRun')}
                  </button>
                {/if}
              </div>
              <div class="title">{item.title}</div>

              {#if item.checklist.length > 0}
                <div class="checklist">
                  <div class="progress">
                    <div
                      class="fill"
                      style="width: {(doneCount(item) / item.checklist.length) * 100}%"
                    ></div>
                  </div>
                  <span class="ptext faint"
                    >{t('board.checklist', {
                      done: doneCount(item),
                      total: item.checklist.length,
                    })}</span
                  >
                </div>
                <ul class="tasks">
                  {#each item.checklist.slice(0, 4) as task (task.id)}
                    <li class="task task-{task.status}">
                      <span class="mark">
                        {task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '▸' : '○'}
                      </span>
                      <span class="ttext">{task.text}</span>
                    </li>
                  {/each}
                  {#if item.checklist.length > 4}
                    <li class="more faint">+{item.checklist.length - 4}</li>
                  {/if}
                </ul>
              {/if}

              <div class="meta">
                {#if item.labels.length > 0}
                  <span class="labels">
                    {#each item.labels.slice(0, 3) as label (label)}
                      <span class="label">{label}</span>
                    {/each}
                  </span>
                {/if}
                <span class="grow"></span>
                {#if item.assignee}<span class="who faint">@{item.assignee}</span>{/if}
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
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .left {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  h1 {
    font-size: 22px;
  }
  .count {
    font-size: 14px;
  }
  .active-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 14%, transparent);
    padding: 2px 10px;
    border-radius: 999px;
  }
  .right {
    display: flex;
    gap: 8px;
  }
  .toggle,
  .refresh {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--panel);
    border: 1px solid var(--line);
    color: var(--muted);
    padding: 6px 12px;
    border-radius: var(--radius-sm);
  }
  .toggle:hover,
  .refresh:hover {
    color: var(--text);
    border-color: var(--line-strong);
  }
  .toggle.on {
    color: var(--ok);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--faint);
  }
  .toggle.on .dot {
    background: var(--ok);
  }
  .pulse {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--warn);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--warn) 70%, transparent);
    animation: pulse 1.8s infinite;
  }
  @keyframes pulse {
    0% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--warn) 60%, transparent);
    }
    70% {
      box-shadow: 0 0 0 6px transparent;
    }
    100% {
      box-shadow: 0 0 0 0 transparent;
    }
  }
  /* Respect users who ask for less motion: drop the looping pulse + bar tween. */
  @media (prefers-reduced-motion: reduce) {
    .pulse {
      animation: none;
    }
    .fill {
      transition: none;
    }
  }
  .stale {
    margin: -4px 0 14px;
    padding: 6px 12px;
    border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--line));
    background: color-mix(in srgb, var(--warn) 10%, transparent);
    color: var(--warn);
    border-radius: var(--radius-sm);
    font-size: 12px;
  }
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
  .ldot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--lane);
  }
  .lane h3 {
    font-size: 13px;
    flex: 1;
  }
  .lcount {
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
  .card.active {
    border-color: color-mix(in srgb, var(--warn) 45%, var(--line));
  }
  .card[draggable='true'] {
    cursor: grab;
  }
  .card.dragging {
    opacity: 0.5;
  }
  .lane.dropping {
    outline: 2px dashed var(--accent);
    outline-offset: -2px;
  }
  .start {
    font-size: 10px;
    color: var(--accent);
    background: transparent;
    border: 1px solid var(--accent-dim);
    border-radius: 999px;
    padding: 1px 8px;
  }
  .start:hover {
    background: var(--accent-dim);
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .key {
    font-size: 11px;
  }
  .running {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 10px;
    color: var(--warn);
  }
  .title {
    margin: 3px 0 8px;
    font-weight: 500;
    line-height: 1.35;
  }
  .checklist {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .progress {
    flex: 1;
    height: 4px;
    background: var(--line);
    border-radius: 999px;
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--ok);
    transition: width 0.3s ease;
  }
  .ptext {
    font-size: 10px;
    white-space: nowrap;
  }
  .tasks {
    list-style: none;
    margin: 0 0 8px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .task {
    display: flex;
    gap: 6px;
    font-size: 11px;
    line-height: 1.3;
    color: var(--muted);
  }
  .task .mark {
    width: 10px;
    flex-shrink: 0;
  }
  .task-completed .ttext {
    text-decoration: line-through;
    color: var(--faint);
  }
  .task-completed .mark {
    color: var(--ok);
  }
  .task-in_progress {
    color: var(--text);
  }
  .task-in_progress .mark {
    color: var(--warn);
  }
  .ttext {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .more {
    font-size: 10px;
    padding-left: 16px;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .grow {
    flex: 1;
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
  .who,
  .runs {
    font-size: 11px;
    white-space: nowrap;
  }
</style>
