<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchHealth,
    fetchSchedules,
    addSchedule,
    toggleSchedule,
    removeSchedule,
    ApiError,
  } from '../lib/api';
  import type { ScheduleJobView } from '../lib/contracts';
  import { t } from '../lib/i18n';
  import Modal from '../lib/Modal.svelte';

  // Scheduled tasks: list them, and (when actions are enabled) add, pause or
  // remove them. Removal is confirmed through a styled dialog.
  let jobs = $state<ScheduleJobView[]>([]);
  let writable = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let cadence = $state('');
  let task = $state('');
  let adding = $state(false);
  let confirmJob = $state<ScheduleJobView | null>(null);

  async function reload(): Promise<void> {
    try {
      jobs = (await fetchSchedules()).schedules;
    } catch (e) {
      error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    }
  }

  onMount(async () => {
    fetchHealth()
      .then((h) => (writable = h.write))
      .catch(() => (writable = false));
    await reload();
    loading = false;
  });

  async function doAdd(): Promise<void> {
    if (cadence.trim().length === 0 || task.trim().length === 0 || adding) return;
    adding = true;
    error = null;
    try {
      jobs = (await addSchedule(cadence.trim(), task.trim())).schedules;
      cadence = '';
      task = '';
    } catch (e) {
      error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    } finally {
      adding = false;
    }
  }

  async function doToggle(job: ScheduleJobView): Promise<void> {
    try {
      await toggleSchedule(job.id, !job.enabled);
      await reload();
    } catch (e) {
      error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    }
  }

  async function doRemove(): Promise<void> {
    const job = confirmJob;
    confirmJob = null;
    if (job === null) return;
    try {
      await removeSchedule(job.id);
      await reload();
    } catch (e) {
      error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    }
  }

  const when = (ms: number | null): string => {
    if (ms === null) return t('scheduler.never');
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? String(ms) : d.toLocaleString();
  };
</script>

<h1>{t('scheduler.title')}</h1>
<p class="subtitle">{t('scheduler.subtitle')}</p>

{#if error !== null}
  <div class="state bad small">{error}</div>
{/if}

{#if loading}
  <div class="state muted">{t('common.loading')}</div>
{:else}
  {#if jobs.length === 0}
    <div class="muted small">{t('scheduler.empty')}</div>
  {:else}
    <ul class="list">
      {#each jobs as job (job.id)}
        <li class="job" class:off={!job.enabled}>
          <div class="main">
            <span class="cadence">{job.cadence}</span>
            <span class="task">{job.task}</span>
          </div>
          <div class="meta faint">
            <span>{t('scheduler.next')}: {when(job.nextRunMs)}</span>
            <span>{t('scheduler.last')}: {when(job.lastRunMs)}</span>
            {#if !job.enabled}<span class="off-badge">{t('scheduler.disabled')}</span>{/if}
          </div>
          {#if writable}
            <div class="actions">
              <button class="btn btn--sm" onclick={() => doToggle(job)}>
                {job.enabled ? t('scheduler.disable') : t('scheduler.enable')}
              </button>
              <button class="btn btn--danger btn--sm" onclick={() => (confirmJob = job)}>
                {t('scheduler.remove')}
              </button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if writable}
    <section class="adder card">
      <span class="adder-label">{t('scheduler.add')}</span>
      <div class="adder-row">
        <input
          class="input cad"
          bind:value={cadence}
          placeholder={t('scheduler.cadencePlaceholder')}
        />
        <input class="input tsk" bind:value={task} placeholder={t('scheduler.taskPlaceholder')} />
        <button
          class="btn btn--primary"
          onclick={doAdd}
          disabled={adding || cadence.trim().length === 0 || task.trim().length === 0}
        >
          {adding ? t('scheduler.adding') : t('scheduler.add')}
        </button>
      </div>
    </section>
  {:else}
    <div class="muted small needwrite">{t('scheduler.needWrite')}</div>
  {/if}
{/if}

{#if confirmJob !== null}
  <Modal title={t('scheduler.remove')} onclose={() => (confirmJob = null)}>
    <p class="confirm-body">
      {t('scheduler.removeConfirm')}
      <strong>{confirmJob.task}</strong>
    </p>
    {#snippet footer()}
      <button type="button" class="btn btn--ghost" onclick={() => (confirmJob = null)}
        >{t('common.cancel')}</button
      >
      <button type="button" class="btn btn--danger" onclick={() => void doRemove()}
        >{t('scheduler.remove')}</button
      >
    {/snippet}
  </Modal>
{/if}

<style>
  h1 {
    font-size: 22px;
    margin-bottom: 4px;
  }
  .subtitle {
    color: var(--muted);
    margin: 0 0 18px;
    font-size: 13px;
  }
  .state {
    padding: 24px 0;
  }
  .state.muted {
    text-align: center;
    padding: 48px 0;
  }
  .list {
    list-style: none;
    margin: 0 0 18px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .job {
    background: var(--panel);
    border: 1px solid var(--line);
    border-left: 2px solid var(--accent);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .job.off {
    border-left-color: var(--line-strong);
    opacity: 0.7;
  }
  .main {
    display: flex;
    gap: 12px;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .cadence {
    font-weight: 600;
    color: var(--accent);
    white-space: nowrap;
  }
  .task {
    flex: 1;
  }
  .meta {
    display: flex;
    gap: 14px;
    font-size: 11px;
    flex-wrap: wrap;
  }
  .off-badge {
    color: var(--warn, #e2b341);
  }
  .actions {
    display: flex;
    gap: 6px;
  }
  .adder {
    margin-top: 4px;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .adder-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
  }
  .adder-row {
    display: flex;
    gap: 8px;
    align-items: stretch;
    flex-wrap: wrap;
  }
  .cad {
    width: 220px;
    flex: none;
  }
  .tsk {
    flex: 1;
    min-width: 200px;
  }
  .confirm-body {
    color: var(--muted);
    line-height: 1.6;
  }
  .confirm-body strong {
    color: var(--text);
  }
  .small {
    font-size: 12px;
  }
  .needwrite {
    margin-top: 8px;
  }
  .state.bad {
    color: var(--bad);
  }
</style>
