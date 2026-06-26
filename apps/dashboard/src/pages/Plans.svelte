<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchPlans, fetchPlan, fetchHealth, shapePlan, startRun, ApiError } from '../lib/api';
  import type { PlanSummary, PlanDetail, PlanShapeView } from '../lib/contracts';
  import { navigate } from '../lib/router.svelte';
  import { t } from '../lib/i18n';
  import Modal from '../lib/Modal.svelte';

  // `id` empty → the plan list (+ a create modal); `id` set → one plan's detail.
  const { id = '' }: { id?: string } = $props();

  let plans = $state<PlanSummary[]>([]);
  let detail = $state<PlanDetail | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let writable = $state(false);

  // --- Create-plan modal: describe a task → (optionally) shape it → execute ---
  let creating = $state(false);
  let taskInput = $state('');
  let shape = $state<PlanShapeView | null>(null);
  let picked = $state<Set<number>>(new Set());
  let answers = $state<string[]>([]);
  let shaping = $state(false);
  let starting = $state(false);
  let shapeError = $state<string | null>(null);

  onMount(() => {
    fetchHealth()
      .then((h) => (writable = h.write))
      .catch(() => (writable = false));
  });

  // Load the list or the detail whenever the route id changes (instance reused
  // when navigating plan → plan); a token discards out-of-order responses.
  let token = 0;
  $effect(() => {
    const pid = id;
    const mine = ++token;
    loading = true;
    error = null;
    detail = null;
    const job =
      pid.length > 0
        ? fetchPlan(pid).then((d) => {
            if (mine === token) detail = d;
          })
        : fetchPlans().then((r) => {
            if (mine === token) plans = r.plans;
          });
    job
      .catch((e: unknown) => {
        if (mine === token) error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
      })
      .finally(() => {
        if (mine === token) loading = false;
      });
  });

  function openCreate(): void {
    taskInput = '';
    shape = null;
    picked = new Set();
    answers = [];
    shapeError = null;
    creating = true;
  }

  async function doShape(): Promise<void> {
    const task = taskInput.trim();
    if (task.length === 0 || shaping) return;
    shaping = true;
    shapeError = null;
    shape = null;
    try {
      const s = await shapePlan(task);
      shape = s;
      picked = new Set(
        s.recommendations.map((r, i) => (r.recommended ? i : -1)).filter((i) => i >= 0),
      );
      answers = s.questions.map(() => '');
    } catch (e) {
      shapeError = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    } finally {
      shaping = false;
    }
  }

  function togglePick(i: number): void {
    const next = new Set(picked);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    picked = next;
  }

  /** Fold the chosen recommendations + answers into the task. */
  function foldedTask(): string {
    let task = taskInput.trim();
    if (shape === null) return task;
    const extras = shape.recommendations
      .filter((_r, i) => picked.has(i))
      .map((r) => `- ${r.title}${r.detail.length > 0 ? ` (${r.detail})` : ''}`);
    if (extras.length > 0) task += `\n\n${t('planShape.consider')}\n${extras.join('\n')}`;
    const qa = shape.questions
      .map((q, i) => ({ q, a: (answers[i] ?? '').trim() }))
      .filter((x) => x.a.length > 0)
      .map((x) => `- ${x.q} → ${x.a}`);
    if (qa.length > 0) task += `\n\n${t('planShape.questions')}\n${qa.join('\n')}`;
    return task;
  }

  async function doStart(): Promise<void> {
    if (taskInput.trim().length === 0 || starting) return;
    starting = true;
    shapeError = null;
    try {
      const { runId } = await startRun({ task: foldedTask() });
      creating = false;
      navigate(`/runs/${runId}`);
    } catch (e) {
      shapeError = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    } finally {
      starting = false;
    }
  }

  function autofocusEl(node: HTMLElement): void {
    node.focus();
  }

  const when = (iso: string | null): string => {
    if (iso === null) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
  };
</script>

{#if id.length > 0}
  <!-- Detail: one plan -->
  <a class="back" href="#/plans">{t('plans.back')}</a>
  {#if loading}
    <div class="state muted">{t('common.loading')}</div>
  {:else if error !== null || detail === null}
    <div class="state bad">{t('common.notFound')}</div>
  {:else}
    <header class="dhead">
      <h1>{detail.task}</h1>
      <div class="dmeta">
        <span class="st st-{detail.status}">{t('plan.status.' + detail.status)}</span>
        {#if detail.created}<span class="faint">{when(detail.created)}</span>{/if}
      </div>
    </header>
    <pre class="body">{detail.body}</pre>
  {/if}
{:else}
  <!-- List -->
  <header class="bar">
    <h1>{t('nav.plans')} <span class="faint count">{plans.length}</span></h1>
    {#if writable}
      <button class="btn btn--primary" onclick={openCreate} aria-haspopup="dialog"
        >+ {t('plans.new')}</button
      >
    {/if}
  </header>

  {#if loading}
    <div class="state muted">{t('common.loading')}</div>
  {:else if error !== null}
    <div class="state bad">{t('common.error')}: {error}</div>
  {:else if plans.length === 0}
    <div class="state muted">
      <p>{t('plans.empty')}</p>
      {#if writable}<button class="btn btn--primary" onclick={openCreate}
          >+ {t('plans.new')}</button
        >{/if}
    </div>
  {:else}
    <ul class="list">
      {#each plans as plan (plan.id)}
        <li>
          <a class="row" href={`#/plans/${encodeURIComponent(plan.id)}`}>
            <span class="ttl">{plan.task}</span>
            <span class="st st-{plan.status}">{t('plan.status.' + plan.status)}</span>
            <span class="faint when">{when(plan.created)}</span>
            <span class="chev faint">›</span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}

  {#if creating}
    <Modal title={t('plans.new')} wide onclose={() => (creating = false)}>
      <div class="mform">
        <label class="field">
          <span>{t('planShape.title')}</span>
          <textarea
            class="input"
            rows="3"
            bind:value={taskInput}
            placeholder={t('planShape.placeholder')}
            use:autofocusEl
          ></textarea>
        </label>
        <div class="shaprow">
          <button
            class="btn btn--ghost btn--sm"
            onclick={doShape}
            disabled={shaping || taskInput.trim().length === 0}
          >
            {shaping ? t('planShape.shaping') : t('planShape.shape')}
          </button>
          <span class="hint faint">{t('planShape.shapeHint')}</span>
        </div>

        {#if shapeError !== null}
          <div class="state bad small">{shapeError}</div>
        {/if}

        {#if shape !== null}
          {#if !shape.surface && shape.recommendations.length === 0 && shape.questions.length === 0}
            <div class="muted small">{t('planShape.clear')}</div>
          {/if}
          {#if shape.recommendations.length > 0}
            <div class="sublabel">{t('planShape.consider')}</div>
            <ul class="recs">
              {#each shape.recommendations as r, i (i)}
                <li>
                  <label class="rec">
                    <input
                      type="checkbox"
                      style="accent-color: var(--accent); width: 15px; height: 15px; flex-shrink: 0;"
                      checked={picked.has(i)}
                      onchange={() => togglePick(i)}
                    />
                    <span class="rttl">{r.title}</span>
                    {#if r.detail.length > 0}<span class="rdetail faint">{r.detail}</span>{/if}
                  </label>
                </li>
              {/each}
            </ul>
          {/if}
          {#if shape.questions.length > 0}
            <div class="sublabel">{t('planShape.questions')}</div>
            <ul class="qs">
              {#each shape.questions as q, i (i)}
                <li class="q">
                  <span class="qttl">{q}</span>
                  <input class="input" bind:value={answers[i]} placeholder={t('planShape.answer')} />
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      </div>
      {#snippet footer()}
        <button type="button" class="btn btn--ghost" onclick={() => (creating = false)}
          >{t('common.cancel')}</button
        >
        <button
          type="button"
          class="btn btn--primary"
          onclick={doStart}
          disabled={starting || taskInput.trim().length === 0}
        >
          {starting ? t('planShape.starting') : t('planShape.start')}
        </button>
      {/snippet}
    </Modal>
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
  .state p {
    margin-bottom: 14px;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    background: linear-gradient(180deg, var(--panel-2), var(--panel));
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 14px 16px;
    color: var(--text);
    box-shadow: var(--shadow-1);
    transition:
      border-color var(--transition),
      transform var(--transition),
      box-shadow var(--transition);
  }
  .row:hover {
    border-color: var(--accent-dim);
    transform: translateY(-2px);
    box-shadow: var(--shadow-2);
    text-decoration: none;
  }
  .ttl {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .when {
    font-size: 11px;
    white-space: nowrap;
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
  .st-executed,
  .st-completed {
    color: var(--ok);
  }
  .st-cancelled {
    color: var(--bad);
  }
  .st-approved,
  .st-proposed {
    color: var(--accent);
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
    line-height: 1.3;
  }
  .dmeta {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 18px;
  }
  .body {
    margin: 0;
    padding: 18px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-x: auto;
  }
  /* Create modal */
  .mform {
    display: flex;
    flex-direction: column;
    gap: 14px;
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
  .mform :global(textarea.input) {
    resize: vertical;
    min-height: 70px;
    line-height: 1.5;
  }
  .shaprow {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .hint {
    font-size: 12px;
  }
  .sublabel {
    font-size: 12px;
    color: var(--muted);
    margin: 6px 0 2px;
  }
  .recs,
  .qs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .rec {
    display: flex;
    align-items: baseline;
    gap: 8px;
    cursor: pointer;
  }
  .rttl {
    font-weight: 500;
  }
  .rdetail {
    font-size: 12px;
  }
  .q {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .qttl {
    font-size: 13px;
  }
  .small {
    font-size: 12px;
  }
  .state.bad {
    color: var(--bad);
  }
</style>
