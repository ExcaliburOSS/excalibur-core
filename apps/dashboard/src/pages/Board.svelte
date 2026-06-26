<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    fetchBoard,
    fetchHealth,
    moveWorkItem,
    startRun,
    createWorkItem,
    deleteWorkItem,
    authToken,
    ApiError,
  } from '../lib/api';
  import {
    LANES,
    LANE_COLORS,
    type BoardResponse,
    type DashboardLane,
    type WorkItemSummary,
  } from '../lib/contracts';
  import { navigate } from '../lib/router.svelte';
  import { t } from '../lib/i18n';
  import Modal from '../lib/Modal.svelte';

  let board = $state<BoardResponse | null>(null);
  let error = $state<string | null>(null);
  /** A poll that failed AFTER we already had data — surfaced non-destructively. */
  let staleError = $state<string | null>(null);
  let loading = $state(true);
  let live = $state(true);
  let writable = $state(false); // interactive actions enabled (serve --write)
  let dragKey = $state<string | null>(null);
  let dropLane = $state<DashboardLane | null>(null);
  // Create work item (the "+ New" modal + per-lane quick-add).
  let creating = $state(false);
  let newTitle = $state('');
  let newLane = $state<DashboardLane>('todo');
  let newLabels = $state('');
  let newDesc = $state('');
  let newPriority = $state('');
  let newAssignee = $state('');
  // Styled confirm dialog (replaces the native window.confirm for deletes).
  let confirmItem = $state<WorkItemSummary | null>(null);
  let quickLane = $state<DashboardLane | null>(null);
  let quickTitle = $state('');
  let busy = $state(false);
  let inFlight = false; // guards against overlapping/clobbering polls
  let timer: ReturnType<typeof setInterval> | null = null;
  let es: EventSource | null = null;
  let reconnect: ReturnType<typeof setTimeout> | null = null;

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
    stream.onopen = () => stopPoll(); // SSE is back → drop the temporary poll
    stream.onerror = () => {
      // SSE dropped — poll meanwhile AND try to re-attach so the board returns
      // to push updates without a manual refresh.
      stream.close();
      es = null;
      startPoll();
      scheduleReconnect();
    };
    es = stream;
  }

  function scheduleReconnect(): void {
    if (reconnect !== null || !live) return;
    reconnect = setTimeout(() => {
      reconnect = null;
      if (live && es === null) connect();
    }, 5000);
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
    if (reconnect !== null) clearTimeout(reconnect);
  });

  const laneLabel = (lane: string): string => t(`lane.${lane}`);

  /** Keyboard-accessible alternative to drag: move a card to the adjacent lane. */
  function moveAdjacent(item: WorkItemSummary, dir: -1 | 1): void {
    const idx = LANES.indexOf(item.lane);
    const target = LANES[idx + dir];
    if (target !== undefined) void moveTo(item.key, target);
  }

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

  /** Focus an input as soon as it appears (quick-add / create), sans a11y autofocus warning. */
  function autofocusEl(node: HTMLElement): void {
    node.focus();
  }

  /** Create a work item in a lane, then refresh so the new card appears. */
  async function create(lane: DashboardLane, title: string, labels: string[] = []): Promise<void> {
    const text = title.trim();
    if (text.length === 0 || busy) return;
    busy = true;
    try {
      await createWorkItem({ title: text, lane, ...(labels.length > 0 ? { labels } : {}) });
      await load(true);
    } catch (e) {
      staleError = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    } finally {
      busy = false;
    }
  }

  async function submitCreate(): Promise<void> {
    const title = newTitle.trim();
    if (title.length === 0 || busy) return;
    const labels = newLabels
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    busy = true;
    try {
      await createWorkItem({
        title,
        lane: newLane,
        ...(newDesc.trim().length > 0 ? { description: newDesc.trim() } : {}),
        ...(labels.length > 0 ? { labels } : {}),
        ...(newPriority.length > 0 ? { priority: newPriority } : {}),
        ...(newAssignee.trim().length > 0 ? { assignee: newAssignee.trim() } : {}),
      });
      await load(true);
      newTitle = '';
      newLabels = '';
      newDesc = '';
      newPriority = '';
      newAssignee = '';
      creating = false;
    } catch (e) {
      staleError = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    } finally {
      busy = false;
    }
  }

  async function submitQuick(lane: DashboardLane): Promise<void> {
    const title = quickTitle;
    quickTitle = '';
    quickLane = null;
    await create(lane, title);
  }

  /** A card's 🗑 opens a styled confirm dialog (no native window.confirm). */
  function removeCard(e: MouseEvent, item: WorkItemSummary): void {
    e.preventDefault();
    e.stopPropagation();
    confirmItem = item;
  }

  /** Confirmed delete (optimistic), with a revert on failure. */
  async function confirmDelete(): Promise<void> {
    const item = confirmItem;
    confirmItem = null;
    if (item === null) return;
    if (board !== null) {
      for (const col of board.lanes) {
        const i = col.items.findIndex((x) => x.key === item.key);
        if (i >= 0) col.items.splice(i, 1);
      }
    }
    try {
      await deleteWorkItem(item.key);
    } catch (err) {
      staleError = err instanceof ApiError ? `${err.status} · ${err.message}` : String(err);
      void load();
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
    <span class="live" title={t('board.liveUpdates')}>
      <span class="live-dot" class:breathe={live}></span>{t('board.live')}
    </span>
    {#if activeCount > 0}
      <span class="active-pill"><span class="pulse"></span>{activeCount} {t('board.active')}</span>
    {/if}
  </div>
  {#if writable}
    <div class="right">
      <button class="new" onclick={() => (creating = true)} aria-haspopup="dialog"
        >+ {t('board.new')}</button
      >
    </div>
  {/if}
</header>

{#if staleError !== null}
  <div class="stale" role="status">{t('common.error')}: {staleError}</div>
{/if}

{#if creating && writable}
  <Modal title={t('board.newFirst')} onclose={() => (creating = false)}>
    <form
      class="mform"
      onsubmit={(e) => {
        e.preventDefault();
        void submitCreate();
      }}
    >
      <label class="field">
        <span>{t('workItem.title')}</span>
        <input
          class="input"
          placeholder={t('board.newTitle')}
          bind:value={newTitle}
          use:autofocusEl
        />
      </label>
      <label class="field">
        <span>{t('workItem.description')}</span>
        <textarea
          class="input"
          rows="3"
          placeholder={t('board.descPlaceholder')}
          bind:value={newDesc}
        ></textarea>
      </label>
      <div class="row2">
        <label class="field">
          <span>{t('board.lane')}</span>
          <select class="input" bind:value={newLane}>
            {#each LANES as lane (lane)}<option value={lane}>{laneLabel(lane)}</option>{/each}
          </select>
        </label>
        <label class="field">
          <span>{t('workItem.priority')}</span>
          <select class="input" bind:value={newPriority}>
            <option value="">{t('priority.none')}</option>
            <option value="low">{t('priority.low')}</option>
            <option value="medium">{t('priority.medium')}</option>
            <option value="high">{t('priority.high')}</option>
            <option value="urgent">{t('priority.urgent')}</option>
          </select>
        </label>
      </div>
      <div class="row2">
        <label class="field">
          <span>{t('workItem.assignee')}</span>
          <input class="input" placeholder="@user" bind:value={newAssignee} />
        </label>
        <label class="field">
          <span>{t('board.labels')}</span>
          <input class="input" placeholder={t('board.newLabels')} bind:value={newLabels} />
        </label>
      </div>
      <button type="submit" class="hidden-submit" tabindex="-1" aria-hidden="true"></button>
    </form>
    {#snippet footer()}
      <button type="button" class="btn btn--ghost" onclick={() => (creating = false)}
        >{t('common.cancel')}</button
      >
      <button
        type="button"
        class="btn btn--primary"
        disabled={busy || newTitle.trim().length === 0}
        onclick={() => void submitCreate()}>{t('board.create')}</button
      >
    {/snippet}
  </Modal>
{/if}

{#if confirmItem !== null}
  <Modal title={t('board.deleteTitle')} onclose={() => (confirmItem = null)}>
    <p class="confirm-body">
      {t('board.deleteBody', { key: confirmItem.key })}
      <strong>{confirmItem.title}</strong>
    </p>
    {#snippet footer()}
      <button type="button" class="btn btn--ghost" onclick={() => (confirmItem = null)}
        >{t('common.cancel')}</button
      >
      <button type="button" class="btn btn--danger" onclick={() => void confirmDelete()}
        >{t('board.delete')}</button
      >
    {/snippet}
  </Modal>
{/if}

{#if loading && board === null}
  <div class="state muted">{t('common.loading')}</div>
{:else if error !== null && board === null}
  <div class="state bad">{t('common.error')}: {error}</div>
{:else if total === 0}
  <div class="state muted">
    {#if writable}
      <p>{t('board.emptyWrite')}</p>
      <button class="primary" onclick={() => (creating = true)}>+ {t('board.newFirst')}</button>
    {:else}
      {t('board.empty')}
    {/if}
  </div>
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
                {#if writable}
                  <!-- Keyboard-accessible alternative to drag-and-drop. -->
                  <button
                    class="move"
                    disabled={LANES.indexOf(item.lane) === 0}
                    title={t('board.moveLeft')}
                    aria-label={t('board.moveLeft')}
                    onclick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      moveAdjacent(item, -1);
                    }}>◀</button
                  >
                  <button
                    class="move"
                    disabled={LANES.indexOf(item.lane) === LANES.length - 1}
                    title={t('board.moveRight')}
                    aria-label={t('board.moveRight')}
                    onclick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      moveAdjacent(item, 1);
                    }}>▶</button
                  >
                  <button
                    class="del"
                    title={t('board.delete')}
                    aria-label={t('board.delete')}
                    onclick={(e) => removeCard(e, item)}>🗑</button
                  >
                {/if}
                {#if item.assignee}<span class="who faint">@{item.assignee}</span>{/if}
                {#if item.runCount > 0}
                  <span class="runs faint">{t('board.runs', { n: item.runCount })}</span>
                {/if}
              </div>
            </a>
          {/each}
          {#if writable}
            {#if quickLane === lane}
              <form
                class="quick"
                onsubmit={(e) => {
                  e.preventDefault();
                  void submitQuick(lane);
                }}
              >
                <input
                  placeholder={t('board.quickAdd')}
                  bind:value={quickTitle}
                  use:autofocusEl
                  onblur={() => {
                    if (quickTitle.trim().length === 0) quickLane = null;
                  }}
                />
              </form>
            {:else}
              <button
                class="addcard"
                onclick={() => {
                  quickTitle = '';
                  quickLane = lane;
                }}>+ {t('board.add')}</button
              >
            {/if}
          {/if}
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
    font-size: 24px;
  }
  .count {
    font-size: 14px;
    font-family: var(--mono);
    color: var(--muted);
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
  .live {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--ok);
  }
  .live-dot.breathe {
    animation: breathe 2.4s ease-in-out infinite;
  }
  @keyframes breathe {
    0%,
    100% {
      opacity: 1;
      box-shadow: 0 0 8px var(--ok);
    }
    50% {
      opacity: 0.55;
      box-shadow: 0 0 2px var(--ok);
    }
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
    gap: 16px;
    align-items: start;
  }
  /* DASH7 — on a phone the 5 lanes become horizontally-scrollable columns
   * (the kanban pattern) instead of squishing to unusable widths. */
  @media (max-width: 720px) {
    .board {
      grid-auto-flow: column;
      grid-template-columns: none;
      grid-auto-columns: 82%;
      overflow-x: auto;
      scroll-snap-type: x proximity;
      padding-bottom: 6px;
    }
    .lane {
      scroll-snap-align: start;
    }
  }
  .lane {
    background: linear-gradient(180deg, var(--panel-2), var(--panel));
    border: 1px solid var(--line);
    border-radius: var(--radius);
    min-height: 120px;
    overflow: hidden;
    box-shadow: var(--shadow-1), var(--inset-top);
  }
  .lane > header {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 13px 14px 12px;
    border-bottom: 1px solid var(--line);
  }
  /* A colored accent strip at the top of each lane (uses the lane's hue). */
  .lane > header::before {
    content: '';
    position: absolute;
    inset: 0 0 auto 0;
    height: 2px;
    background: var(--lane);
    opacity: 0.85;
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
    background: linear-gradient(180deg, var(--panel-3), var(--panel-2));
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 11px 12px;
    color: var(--text);
    box-shadow: var(--shadow-1);
    transition:
      border-color var(--transition),
      box-shadow var(--transition),
      transform var(--transition);
  }
  .card:hover {
    border-color: var(--accent-dim);
    transform: translateY(-2px);
    box-shadow: var(--shadow-2);
    text-decoration: none;
  }
  .card.active {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--line));
    box-shadow:
      0 0 0 1px rgba(77, 163, 255, 0.22),
      0 10px 26px -14px rgba(77, 163, 255, 0.6);
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
  .move {
    font-size: 10px;
    line-height: 1;
    color: var(--muted);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 2px 5px;
  }
  .move:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--line-strong);
  }
  .move:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .new {
    background: linear-gradient(180deg, var(--accent), var(--accent-dim));
    color: #04101e;
    border: 1px solid transparent;
    padding: 6px 14px;
    border-radius: var(--radius-sm);
    font-weight: 650;
    box-shadow: 0 6px 18px -8px rgba(77, 163, 255, 0.7);
  }
  .new:hover {
    filter: brightness(1.07);
  }
  /* Create-work-item modal form. */
  .mform {
    display: flex;
    flex-direction: column;
    gap: 15px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .field > span {
    font-size: 12px;
    font-weight: 550;
    color: var(--muted);
  }
  .row2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }
  .mform :global(textarea.input) {
    resize: vertical;
    min-height: 64px;
    line-height: 1.5;
  }
  .hidden-submit {
    display: none;
  }
  .confirm-body {
    color: var(--muted);
    line-height: 1.6;
  }
  .confirm-body strong {
    color: var(--text);
  }
  @media (max-width: 560px) {
    .row2 {
      grid-template-columns: 1fr;
    }
  }
  .primary {
    background: linear-gradient(180deg, var(--accent), var(--accent-dim));
    color: #04101e;
    border: 1px solid transparent;
    padding: 7px 16px;
    border-radius: var(--radius-sm);
    font-weight: 650;
    box-shadow: 0 6px 18px -8px rgba(77, 163, 255, 0.7);
  }
  .primary:hover {
    filter: brightness(1.07);
  }
  .primary:disabled {
    opacity: 0.5;
  }
  .quick input {
    width: 100%;
    box-sizing: border-box;
    background: var(--panel-2);
    border: 1px solid var(--accent-dim);
    color: var(--text);
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    font: inherit;
  }
  .addcard {
    width: 100%;
    text-align: left;
    background: transparent;
    border: 1px dashed var(--line);
    color: var(--muted);
    padding: 7px 10px;
    border-radius: var(--radius-sm);
    font-size: 12px;
  }
  .addcard:hover {
    color: var(--text);
    border-color: var(--line-strong);
  }
  .del {
    font-size: 11px;
    line-height: 1;
    background: transparent;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 2px 5px;
    opacity: 0.55;
  }
  .del:hover {
    opacity: 1;
    border-color: var(--warn);
  }
  .state p {
    margin-bottom: 12px;
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
    background: linear-gradient(90deg, var(--accent), var(--ok));
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
    background: var(--accent-soft);
    color: var(--accent-2);
    border: 1px solid rgba(77, 163, 255, 0.2);
    padding: 1px 7px;
    border-radius: 999px;
  }
  .who,
  .runs {
    font-size: 11px;
    white-space: nowrap;
  }
</style>
