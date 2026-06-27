<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchWorkItem,
    fetchHealth,
    startRun,
    cancelRun,
    approveRun,
    updateWorkItem,
    deleteWorkItem,
    addComment,
    checklistMutate,
    ApiError,
  } from '../lib/api';
  import { LANES, type DashboardLane, type WorkItemDetail } from '../lib/contracts';
  import { navigate } from '../lib/router.svelte';
  import { t } from '../lib/i18n';
  import Modal from '../lib/Modal.svelte';

  const { key }: { key: string } = $props();

  let item = $state<WorkItemDetail | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let writable = $state(false);
  let actionError = $state<string | null>(null);

  // Edit modal + delete confirm + inline add boxes.
  let editing = $state(false);
  let confirmingDelete = $state(false);
  let eTitle = $state('');
  let eDesc = $state('');
  let eLabels = $state('');
  let ePriority = $state('');
  let eAssignee = $state('');
  let eLane = $state<DashboardLane>('todo');
  let newComment = $state('');
  let newCheck = $state('');
  let busy = $state(false);

  const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
  /** Show a known priority via its localized label; fall back to the raw value. */
  const prettyPriority = (p: string): string => (PRIORITIES.includes(p) ? t('priority.' + p) : p);

  async function mutateCheck(
    op:
      | { action: 'add'; text: string }
      | { action: 'toggle'; id: string }
      | { action: 'remove'; id: string },
  ): Promise<void> {
    if (item === null) return;
    actionError = null;
    try {
      item = await checklistMutate(item.key, op);
    } catch (e) {
      actionError = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    }
  }

  async function addCheck(): Promise<void> {
    const text = newCheck.trim();
    if (text.length === 0) return;
    newCheck = '';
    await mutateCheck({ action: 'add', text });
  }

  function startEdit(): void {
    if (item === null) return;
    eTitle = item.title;
    eDesc = item.description ?? '';
    eLabels = item.labels.join(', ');
    ePriority = item.priority ?? '';
    eAssignee = item.assignee ?? '';
    eLane = item.lane;
    editing = true;
  }

  async function saveEdit(): Promise<void> {
    if (item === null || busy || eTitle.trim().length === 0) return;
    busy = true;
    actionError = null;
    try {
      item = await updateWorkItem(item.key, {
        title: eTitle.trim(),
        description: eDesc.trim().length > 0 ? eDesc : null,
        labels: eLabels
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        priority: ePriority.trim().length > 0 ? ePriority.trim() : null,
        assignee: eAssignee.trim().length > 0 ? eAssignee.trim() : null,
        lane: eLane,
      });
      editing = false;
    } catch (e) {
      actionError = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    } finally {
      busy = false;
    }
  }

  async function submitComment(): Promise<void> {
    if (item === null || newComment.trim().length === 0 || busy) return;
    busy = true;
    actionError = null;
    try {
      item = await addComment(item.key, newComment.trim());
      newComment = '';
    } catch (e) {
      actionError = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    } finally {
      busy = false;
    }
  }

  async function doDelete(): Promise<void> {
    if (item === null) return;
    confirmingDelete = false;
    try {
      await deleteWorkItem(item.key);
      navigate('/');
    } catch (e) {
      actionError = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    }
  }

  onMount(() => {
    fetchHealth()
      .then((h) => (writable = h.write))
      .catch(() => (writable = false));
  });

  async function reload(): Promise<void> {
    try {
      item = await fetchWorkItem(key);
    } catch {
      /* keep current */
    }
  }

  async function act(fn: () => Promise<unknown>): Promise<void> {
    actionError = null;
    try {
      await fn();
      await reload();
    } catch (e) {
      actionError = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    }
  }

  async function onStartRun(): Promise<void> {
    if (item === null) return;
    actionError = null;
    try {
      const { runId } = await startRun({ task: item.title, workItemId: item.key });
      navigate(`/runs/${runId}`);
    } catch (e) {
      actionError = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    }
  }

  // Re-fetch whenever `key` changes — the component instance is REUSED when
  // navigating WI-1 → WI-2 (same route branch), so onMount alone would show
  // stale data. An incrementing token discards out-of-order responses.
  let token = 0;
  $effect(() => {
    const k = key;
    const mine = ++token;
    loading = true;
    error = null;
    item = null;
    fetchWorkItem(k)
      .then((d) => {
        if (mine === token) item = d;
      })
      .catch((e: unknown) => {
        if (mine === token) error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
      })
      .finally(() => {
        if (mine === token) loading = false;
      });
  });

  // Defense in depth: the server already sanitizes link URLs, but guard the href
  // here too so a script-bearing scheme can never reach the DOM.
  const safeHref = (url: string): string => {
    const c = Array.from(url).filter((ch) => { const n = ch.charCodeAt(0); return n > 0x1f && (n < 0x7f || n > 0x9f); }).join('').trim();
    if (/^(https?:|mailto:)/i.test(c)) return c;
    if (c.startsWith('#')) return c;
    if (c.startsWith('/') && !c.startsWith('//')) return c;
    return '#';
  };
</script>

<a class="back" href="#/">← {t('workItem.back')}</a>

{#if loading}
  <div class="state muted">{t('common.loading')}</div>
{:else if error !== null || item === null}
  <div class="state bad">{t('workItem.none', { key })}</div>
{:else}
  <header class="head">
    <div class="key mono faint">{item.key}</div>
    <h1>{item.title}</h1>
    <div class="badges">
      <span class="lane">{t('lane.' + item.lane)}</span>
      {#if item.priority}<span class="badge prio-{item.priority}">{prettyPriority(item.priority)}</span
        >{/if}
      {#if item.assignee}<span class="badge">@{item.assignee}</span>{/if}
      {#if item.parentKey}
        <a class="badge epic" href={`#/work-items/${encodeURIComponent(item.parentKey)}`}
          >▸ {item.parentKey}</a
        >
      {/if}
      {#if item.children.length > 0}
        <span class="badge epic">{t('workItem.epicOf', { count: item.children.length })}</span>
      {/if}
      {#each item.labels as label (label)}<span class="badge label">{label}</span>{/each}
    </div>
    {#if writable}
      <div class="actions">
        <button class="btn btn--primary btn--sm" onclick={onStartRun}
          >▸ {t('workItem.startRun')}</button
        >
        <button class="btn btn--sm" onclick={startEdit}>{t('common.edit')}</button>
        <button class="btn btn--danger btn--sm" onclick={() => (confirmingDelete = true)}
          >{t('board.delete')}</button
        >
      </div>
    {/if}
  </header>

  {#if actionError !== null}
    <div class="action-error" role="alert">{t('workItem.actionFailed')}: {actionError}</div>
  {/if}

  {#if item.description}
    <p class="desc">{item.description}</p>
  {/if}

  {#if item.blockedBy.length > 0}
    <div class="deprow">
      <span class="deplabel faint">{t('workItem.blockedBy')}</span>
      {#each item.blockedBy as dep (dep)}
        <a class="badge dep" href={`#/work-items/${encodeURIComponent(dep)}`}>⟂ {dep}</a>
      {/each}
    </div>
  {/if}

  {#if item.plans.length > 0}
    <section>
      <h2>{t('workItem.plans')} <span class="faint">({item.plans.length})</span></h2>
      <ul class="links">
        {#each item.plans as plan (plan.id)}
          <li>
            <a class="rlink" href={`#/plans/${encodeURIComponent(plan.id)}`}>{plan.id}</a>
            <span class="badge st-{plan.status}">{t('plan.status.' + plan.status)}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if item.children.length > 0}
    <section>
      <h2>{t('workItem.subtasks')} <span class="faint">({item.children.length})</span></h2>
      <ul class="subtasks">
        {#each item.children as child (child.key)}
          <li>
            <a class="rlink mono" href={`#/work-items/${encodeURIComponent(child.key)}`}
              >{child.key}</a
            >
            <span class="ctitle">{child.title}</span>
            <span class="lane sm">{t('lane.' + child.lane)}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if item.authoredChecklist.length > 0 || writable}
    <section>
      <h2>
        {t('workItem.checklist')}
        {#if item.authoredChecklist.length > 0}
          <span class="faint"
            >({item.authoredChecklist.filter((c) => c.done).length}/{item.authoredChecklist
              .length})</span
          >
        {/if}
      </h2>
      {#if item.authoredChecklist.length > 0}
        <ul class="check">
          {#each item.authoredChecklist as c (c.id)}
            <li class:done={c.done}>
              <button
                class="cbox"
                class:on={c.done}
                aria-pressed={c.done}
                disabled={!writable}
                onclick={() => mutateCheck({ action: 'toggle', id: c.id })}>{c.done ? '✓' : ''}</button
              >
              <span class="ctext">{c.text}</span>
              {#if writable}
                <button
                  class="cdel"
                  title={t('board.delete')}
                  aria-label={t('board.delete')}
                  onclick={() => mutateCheck({ action: 'remove', id: c.id })}>×</button
                >
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if writable}
        <form
          class="addc"
          onsubmit={(e) => {
            e.preventDefault();
            void addCheck();
          }}
        >
          <input class="input" bind:value={newCheck} placeholder={t('workItem.addCheck')} />
          <button type="submit" class="btn btn--sm" disabled={newCheck.trim().length === 0}
            >{t('board.add')}</button
          >
        </form>
      {/if}
    </section>
  {/if}

  <section>
    <h2>{t('workItem.runs')} <span class="faint">({item.runs.length})</span></h2>
    {#if item.runs.length === 0}
      <div class="muted small empty">{t('workItem.noRuns')}</div>
    {:else}
      <ul class="runs">
        {#each item.runs as run (run.id)}
          <li>
            <span class="st st-{run.status}">{t('status.' + run.status)}</span>
            <a class="rlink" href={`#/runs/${run.id}`}>{run.title || t('workItem.runs')}</a>
            {#if run.model}<span class="faint small">{run.model}</span>{/if}
            <span class="grow"></span>
            {#if writable && run.status === 'running'}
              <button class="btn btn--sm" onclick={() => act(() => cancelRun(run.id))}>
                {t('workItem.cancelRun')}
              </button>
            {:else if writable && run.status === 'waiting_approval'}
              <button class="btn btn--primary btn--sm" onclick={() => act(() => approveRun(run.id, true))}>
                {t('workItem.approve')}
              </button>
              <button class="btn btn--danger btn--sm" onclick={() => act(() => approveRun(run.id, false))}>
                {t('workItem.reject')}
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if item.links.length > 0}
    <section>
      <h2>{t('workItem.links')}</h2>
      <ul class="links">
        {#each item.links as link (link.url)}
          <li>
            <a href={safeHref(link.url)} target="_blank" rel="noreferrer">{link.title ?? link.url}</a>
            <span class="faint small">{link.type}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if item.comments.length > 0 || writable}
    <section>
      <h2>{t('workItem.comments')}</h2>
      {#if item.comments.length > 0}
        <ul class="comments">
          {#each item.comments as c, i (i)}
            <li><span class="cauthor faint">{c.author ?? '—'}</span> {c.body}</li>
          {/each}
        </ul>
      {/if}
      {#if writable}
        <form
          class="addc"
          onsubmit={(e) => {
            e.preventDefault();
            void submitComment();
          }}
        >
          <input class="input" bind:value={newComment} placeholder={t('workItem.addComment')} />
          <button type="submit" class="btn btn--sm" disabled={busy || newComment.trim().length === 0}
            >{t('workItem.comment')}</button
          >
        </form>
      {/if}
    </section>
  {/if}

  <!-- Edit task -->
  {#if editing}
    <Modal title={t('workItem.editTitle')} onclose={() => (editing = false)}>
      <form
        class="mform"
        onsubmit={(e) => {
          e.preventDefault();
          void saveEdit();
        }}
      >
        <label class="field">
          <span>{t('workItem.title')}</span>
          <input class="input" bind:value={eTitle} />
        </label>
        <label class="field">
          <span>{t('workItem.description')}</span>
          <textarea class="input" rows="3" bind:value={eDesc}></textarea>
        </label>
        <div class="row2">
          <label class="field">
            <span>{t('board.lane')}</span>
            <select class="input" bind:value={eLane}>
              {#each LANES as l (l)}<option value={l}>{t('lane.' + l)}</option>{/each}
            </select>
          </label>
          <label class="field">
            <span>{t('workItem.priority')}</span>
            <select class="input" bind:value={ePriority}>
              <option value="">{t('priority.none')}</option>
              {#each PRIORITIES as p (p)}<option value={p}>{t('priority.' + p)}</option>{/each}
            </select>
          </label>
        </div>
        <div class="row2">
          <label class="field">
            <span>{t('workItem.assignee')}</span>
            <input class="input" bind:value={eAssignee} placeholder="@user" />
          </label>
          <label class="field">
            <span>{t('board.labels')}</span>
            <input class="input" bind:value={eLabels} placeholder={t('board.newLabels')} />
          </label>
        </div>
        <button type="submit" class="hidden-submit" tabindex="-1" aria-hidden="true"></button>
      </form>
      {#snippet footer()}
        <button type="button" class="btn btn--ghost" onclick={() => (editing = false)}
          >{t('common.cancel')}</button
        >
        <button
          type="button"
          class="btn btn--primary"
          disabled={busy || eTitle.trim().length === 0}
          onclick={() => void saveEdit()}>{t('common.save')}</button
        >
      {/snippet}
    </Modal>
  {/if}

  <!-- Delete confirm -->
  {#if confirmingDelete}
    <Modal title={t('board.deleteTitle')} onclose={() => (confirmingDelete = false)}>
      <p class="confirm-body">
        {t('board.deleteBody', { key: item.key })}
        <strong>{item.title}</strong>
      </p>
      {#snippet footer()}
        <button type="button" class="btn btn--ghost" onclick={() => (confirmingDelete = false)}
          >{t('common.cancel')}</button
        >
        <button type="button" class="btn btn--danger" onclick={() => void doDelete()}
          >{t('board.delete')}</button
        >
      {/snippet}
    </Modal>
  {/if}
{/if}

<style>
  .back {
    display: inline-block;
    margin-bottom: 16px;
    color: var(--muted);
    font-size: 13px;
  }
  .state {
    padding: 48px 0;
    text-align: center;
  }
  .head .key {
    font-size: 12px;
  }
  .head h1 {
    margin: 4px 0 12px;
    font-size: 26px;
  }
  .badges {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  .lane,
  .badge {
    font-size: 11px;
    padding: 2px 9px;
    border-radius: 999px;
    background: var(--panel-2);
    border: 1px solid var(--line);
  }
  .lane {
    background: var(--accent-soft);
    border-color: rgba(77, 163, 255, 0.25);
    color: var(--accent-2);
  }
  .label {
    background: var(--accent-soft);
    border-color: rgba(77, 163, 255, 0.2);
    color: var(--accent-2);
  }
  .prio-high,
  .prio-urgent {
    background: color-mix(in srgb, var(--bad) 14%, transparent);
    border-color: color-mix(in srgb, var(--bad) 35%, var(--line));
    color: var(--bad);
  }
  .prio-medium {
    background: color-mix(in srgb, var(--warn) 14%, transparent);
    border-color: color-mix(in srgb, var(--warn) 35%, var(--line));
    color: var(--warn);
  }
  .desc {
    color: var(--muted);
    max-width: 72ch;
    white-space: pre-wrap;
    margin-top: 14px;
    line-height: 1.6;
  }
  .actions {
    margin-top: 16px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  section {
    margin-top: 30px;
  }
  h2 {
    font-size: 15px;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--line);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .empty {
    padding: 8px 0;
  }
  .runs li {
    display: flex;
    gap: 10px;
    align-items: center;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 9px 12px;
  }
  .rlink {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .grow {
    flex: 1;
  }
  .action-error {
    margin: 12px 0;
    padding: 8px 12px;
    border: 1px solid color-mix(in srgb, var(--bad) 40%, var(--line));
    background: color-mix(in srgb, var(--bad) 10%, transparent);
    color: var(--bad);
    border-radius: var(--radius-sm);
    font-size: 12px;
  }
  .st {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--panel-2);
    white-space: nowrap;
  }
  .st-completed {
    color: var(--ok);
  }
  .st-failed {
    color: var(--bad);
  }
  .st-running,
  .st-waiting_approval {
    color: var(--accent);
  }
  .small {
    font-size: 12px;
  }
  /* Modal form (shared shape with the board's create modal). */
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
  .addc {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
  .addc .input {
    flex: 1;
  }
  .links li {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  /* PLAN2 — epic chip, dependency edges, sub-tasks */
  .badge.epic {
    background: var(--accent-soft);
    border-color: rgba(77, 163, 255, 0.3);
    color: var(--accent-2);
    font-family: var(--mono);
  }
  .deprow {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 14px;
  }
  .deplabel {
    font-size: 12px;
  }
  .badge.dep {
    font-family: var(--mono);
    color: var(--warn);
    border-color: color-mix(in srgb, var(--warn) 35%, var(--line));
  }
  .subtasks {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .subtasks li {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .ctitle {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lane.sm {
    font-size: 10px;
    padding: 1px 7px;
  }
  .comments li {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 9px 12px;
    line-height: 1.5;
  }
  .cauthor {
    font-weight: 550;
    margin-right: 4px;
  }
  .check li {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .check li.done .ctext {
    text-decoration: line-through;
    color: var(--faint);
  }
  .cbox {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    border: 1px solid var(--line-strong);
    border-radius: 5px;
    background: var(--bg-2);
    color: #04101e;
    font-size: 11px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition:
      background var(--transition),
      border-color var(--transition);
  }
  .cbox.on {
    background: var(--ok);
    border-color: var(--ok);
  }
  .cbox:disabled {
    cursor: default;
  }
  .ctext {
    flex: 1;
  }
  .cdel {
    background: transparent;
    border: none;
    color: var(--faint);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
  }
  .cdel:hover {
    color: var(--bad);
  }
  @media (max-width: 560px) {
    .row2 {
      grid-template-columns: 1fr;
    }
  }
</style>
