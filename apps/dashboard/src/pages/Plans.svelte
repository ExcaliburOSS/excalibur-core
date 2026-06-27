<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchPlans, fetchPlan, fetchHealth, shapePlan, startRun, ApiError } from '../lib/api';
  import type {
    PlanSummary,
    PlanDetail,
    PlanProgressDto,
    PlanShapeView,
    PlanStepStatusDto,
  } from '../lib/contracts';
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

  /** Completion percentage (0–100) for a plan's step roll-up. */
  const pct = (p: PlanProgressDto): number =>
    p.total === 0 ? 0 : Math.round((p.done / p.total) * 100);

  /** A glyph for each structured-step status (mirrors the TUI step markers). */
  const stepGlyph = (s: PlanStepStatusDto): string =>
    s === 'done' ? '✓' : s === 'active' ? '▸' : s === 'blocked' ? '✗' : s === 'skipped' ? '⊘' : '○';
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
        {#if detail.resumable}
          <span class="resume" title={t('plan.resumableHint')}>↻ {t('plan.resumable')}</span>
        {/if}
        {#if detail.created}<span class="faint">{when(detail.created)}</span>{/if}
      </div>
      {#if detail.progress.total > 0}
        <div class="progress">
          <div class="track"><div class="fill" style={`width:${pct(detail.progress)}%`}></div></div>
          <span class="pcount faint"
            >{t('plan.progress', { done: detail.progress.done, total: detail.progress.total })}</span
          >
        </div>
      {/if}
    </header>

    {#if detail.phases.length > 0 && detail.progress.total > 0}
      <section class="tree">
        <div class="sublabel">{t('plan.steps')}</div>
        {#each detail.phases as phase (phase.id)}
          <div class="phase">
            <div class="phname">{phase.title}</div>
            <ul class="steps">
              {#each phase.steps as step (step.id)}
                <li
                  class="step step-{step.status}"
                  class:next={step.id === detail.nextStepId}
                  title={t('plan.step.' + step.status)}
                >
                  <span class="glyph">{stepGlyph(step.status)}</span>
                  <span class="sttl">{step.title}</span>
                  {#if step.id === detail.nextStepId}
                    <span class="nexttag">{t('plan.nextStep')}</span>
                  {/if}
                  {#if step.runId}
                    <a class="runlink faint" href={`#/runs/${encodeURIComponent(step.runId)}`}
                      >{step.runId.slice(0, 10)}</a
                    >
                  {/if}
                </li>
              {/each}
            </ul>
          </div>
        {/each}
      </section>
    {/if}

    <details class="mdblock" open={detail.progress.total === 0}>
      <summary class="faint">{t('plan.markdown')}</summary>
      <pre class="body">{detail.body}</pre>
    </details>
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
            {#if plan.resumable}
              <span class="rdot" title={t('plan.resumableHint')} aria-label={t('plan.resumable')}
              ></span>
            {/if}
            {#if plan.progress.total > 0}
              <span class="miniprog" title={t('plan.progress', { done: plan.progress.done, total: plan.progress.total })}>
                <span class="minitrack"
                  ><span class="minifill" style={`width:${pct(plan.progress)}%`}></span></span
                >
                <span class="faint mininum">{plan.progress.done}/{plan.progress.total}</span>
              </span>
            {/if}
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

  /* Resumable badge (detail) + dot (list) */
  .resume {
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 999px;
    color: var(--accent);
    border: 1px solid var(--accent-dim);
    white-space: nowrap;
  }
  .rdot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
    flex-shrink: 0;
  }

  /* Progress bar (detail header) */
  .progress {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 18px;
  }
  .track {
    flex: 1;
    height: 6px;
    border-radius: 999px;
    background: var(--panel-2);
    overflow: hidden;
    max-width: 360px;
  }
  .fill {
    height: 100%;
    border-radius: 999px;
    background: linear-gradient(90deg, var(--accent-dim), var(--accent));
    transition: width var(--transition);
  }
  .pcount {
    font-family: var(--mono);
    font-size: 12px;
    white-space: nowrap;
  }

  /* Mini progress in a list row */
  .miniprog {
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .minitrack {
    width: 56px;
    height: 5px;
    border-radius: 999px;
    background: var(--panel-2);
    overflow: hidden;
  }
  .minifill {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: linear-gradient(90deg, var(--accent-dim), var(--accent));
  }
  .mininum {
    font-family: var(--mono);
    font-size: 11px;
  }

  /* Structured plan tree (detail) */
  .tree {
    margin-bottom: 18px;
  }
  .phase {
    margin-bottom: 14px;
  }
  .phname {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 6px;
    color: var(--text);
  }
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .step {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 12px;
    border: 1px solid var(--line);
    border-left: 3px solid var(--line);
    border-radius: var(--radius);
    background: var(--panel);
    font-size: 13px;
  }
  .step .glyph {
    font-family: var(--mono);
    width: 14px;
    text-align: center;
    flex-shrink: 0;
  }
  .step .sttl {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .step-done {
    border-left-color: var(--ok);
  }
  .step-done .glyph {
    color: var(--ok);
  }
  .step-done .sttl {
    color: var(--muted);
  }
  .step-active {
    border-left-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 7%, var(--panel));
  }
  .step-active .glyph {
    color: var(--accent);
  }
  .step-blocked {
    border-left-color: var(--bad);
  }
  .step-blocked .glyph {
    color: var(--bad);
  }
  .step-skipped .sttl {
    color: var(--muted);
    text-decoration: line-through;
  }
  .step.next {
    border-left-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-dim) inset;
  }
  .nexttag {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 6px;
    border-radius: 999px;
    color: var(--accent);
    border: 1px solid var(--accent-dim);
    flex-shrink: 0;
  }
  .runlink {
    font-family: var(--mono);
    font-size: 11px;
    flex-shrink: 0;
  }

  /* Collapsible raw markdown */
  .mdblock {
    margin-top: 8px;
  }
  .mdblock > summary {
    cursor: pointer;
    font-size: 12px;
    margin-bottom: 8px;
    user-select: none;
  }
</style>
