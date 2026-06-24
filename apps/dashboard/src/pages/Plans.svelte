<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchPlans,
    fetchPlan,
    fetchDiscovery,
    fetchHealth,
    shapePlan,
    startRun,
    ApiError,
  } from '../lib/api';
  import type { PlanSummary, PlanDetail, DiscoverySummary, PlanShapeView } from '../lib/contracts';
  import { navigate } from '../lib/router.svelte';
  import { t } from '../lib/i18n';

  let plans = $state<PlanSummary[]>([]);
  let discovery = $state<DiscoverySummary[]>([]);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let openId = $state<string | null>(null);
  let openBody = $state<PlanDetail | null>(null);

  // --- Plan-shaping panel (D): shape a task → toggle scope → start a run ---
  let writable = $state(false);
  let taskInput = $state('');
  let shape = $state<PlanShapeView | null>(null);
  let picked = $state<Set<number>>(new Set());
  let answers = $state<string[]>([]);
  let shaping = $state(false);
  let starting = $state(false);
  let shapeError = $state<string | null>(null);

  onMount(async () => {
    fetchHealth()
      .then((h) => (writable = h.write))
      .catch(() => (writable = false));
    try {
      const [p, d] = await Promise.all([fetchPlans(), fetchDiscovery()]);
      plans = p.plans;
      discovery = d.discovery;
    } catch (e) {
      error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    } finally {
      loading = false;
    }
  });

  async function doShape(): Promise<void> {
    const task = taskInput.trim();
    if (task.length === 0 || shaping) return;
    shaping = true;
    shapeError = null;
    shape = null;
    try {
      const s = await shapePlan(task);
      shape = s;
      // Pre-check the recommended rows; one click to accept the suggested set.
      picked = new Set(s.recommendations.map((r, i) => (r.recommended ? i : -1)).filter((i) => i >= 0));
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

  /** Fold the chosen recommendations + answers into the task (mirrors the CLI). */
  function foldedTask(): string {
    let task = taskInput.trim();
    if (shape === null) return task;
    const extras = shape.recommendations
      .filter((_r, i) => picked.has(i))
      .map((r) => `- ${r.title}${r.detail.length > 0 ? ` (${r.detail})` : ''}`);
    if (extras.length > 0) {
      task += `\n\nAlso include in the plan:\n${extras.join('\n')}`;
    }
    const qa = shape.questions
      .map((q, i) => ({ q, a: (answers[i] ?? '').trim() }))
      .filter((x) => x.a.length > 0)
      .map((x) => `- ${x.q} → ${x.a}`);
    if (qa.length > 0) {
      task += `\n\nClarifications (from the user):\n${qa.join('\n')}`;
    }
    return task;
  }

  async function doStart(): Promise<void> {
    if (taskInput.trim().length === 0 || starting) return;
    starting = true;
    shapeError = null;
    try {
      const { runId } = await startRun({ task: foldedTask() });
      navigate(`/runs/${runId}`);
    } catch (e) {
      shapeError = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
      starting = false;
    }
  }

  async function toggle(id: string): Promise<void> {
    if (openId === id) {
      openId = null;
      openBody = null;
      return;
    }
    openId = id;
    openBody = null;
    try {
      openBody = await fetchPlan(id);
    } catch {
      openBody = null;
    }
  }

  const when = (iso: string | null): string => {
    if (iso === null) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
  };

  // Recommendation is a wide enum (build_now, refine_first, …) — humanize the
  // snake_case for display rather than enumerate every value in the catalog.
  const humanize = (s: string): string =>
    s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
</script>

<h1>{t('plans.title')}</h1>

<section class="shaper">
  <h2>{t('planShape.title')}</h2>
  {#if !writable}
    <div class="muted small">{t('planShape.needWrite')}</div>
  {:else}
    <div class="shaprow">
      <textarea
        class="taskin"
        bind:value={taskInput}
        placeholder={t('planShape.placeholder')}
        rows="2"
      ></textarea>
      <button class="btn" onclick={doShape} disabled={shaping || taskInput.trim().length === 0}>
        {shaping ? t('planShape.shaping') : t('planShape.shape')}
      </button>
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
                <input type="checkbox" checked={picked.has(i)} onchange={() => togglePick(i)} />
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
              <input class="qin" bind:value={answers[i]} placeholder={t('planShape.answer')} />
            </li>
          {/each}
        </ul>
      {/if}
      <button class="btn primary" onclick={doStart} disabled={starting}>
        {starting ? t('planShape.starting') : t('planShape.start')}
      </button>
    {/if}
  {/if}
</section>

{#if loading}
  <div class="state muted">{t('common.loading')}</div>
{:else if error !== null}
  <div class="state bad">{t('common.error')}: {error}</div>
{:else}
  <div class="cols">
    <section>
      <h2>{t('plans.plans')} <span class="faint">({plans.length})</span></h2>
      {#if plans.length === 0}
        <div class="muted small">{t('plans.empty')}</div>
      {:else}
        <ul class="list">
          {#each plans as plan (plan.id)}
            <li class="item">
              <button class="row" onclick={() => toggle(plan.id)}>
                <span class="caret">{openId === plan.id ? '▾' : '▸'}</span>
                <span class="ttl">{plan.task}</span>
                <span class="st st-{plan.status}">{t('plan.status.' + plan.status)}</span>
                <span class="faint when">{when(plan.created)}</span>
              </button>
              {#if openId === plan.id}
                <pre class="body">{openBody ? openBody.body : t('common.loading')}</pre>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section>
      <h2>{t('plans.discovery')} <span class="faint">({discovery.length})</span></h2>
      {#if discovery.length === 0}
        <div class="muted small">{t('plans.discoveryEmpty')}</div>
      {:else}
        <ul class="list">
          {#each discovery as d (d.id)}
            <li class="dcard">
              <div class="drow">
                <span class="ttl">{d.title}</span>
                <span class="st st-{d.status}">{t('discovery.status.' + d.status)}</span>
              </div>
              <div class="dmeta faint">
                {#if d.recommendation}<span class="rec">{humanize(d.recommendation)}</span>{/if}
                {#if d.recommendedAutonomyLevel !== null}
                  <span>{t('plans.readiness', { level: d.recommendedAutonomyLevel })}</span>
                {/if}
                <span>{when(d.createdAt)}</span>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
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
  .cols {
    display: grid;
    grid-template-columns: 1.4fr 1fr;
    gap: 24px;
    align-items: start;
  }
  h2 {
    font-size: 15px;
    margin-bottom: 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--line);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    color: var(--text);
  }
  .row:hover {
    border-color: var(--line-strong);
  }
  .caret {
    color: var(--faint);
    width: 12px;
  }
  .ttl {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .when {
    font-size: 11px;
    white-space: nowrap;
  }
  .st {
    font-size: 10px;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--panel-2);
  }
  .st-executed,
  .st-completed {
    color: var(--ok);
  }
  .st-cancelled {
    color: var(--bad);
  }
  .st-approved,
  .st-open {
    color: var(--accent);
  }
  .body {
    margin: 4px 0 0;
    padding: 12px;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    font-family: var(--mono);
    font-size: 12px;
    white-space: pre-wrap;
    overflow-x: auto;
    max-height: 420px;
  }
  .dcard {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
  }
  .drow {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dmeta {
    display: flex;
    gap: 10px;
    font-size: 11px;
    margin-top: 4px;
    flex-wrap: wrap;
  }
  .rec {
    color: var(--accent);
  }
  .small {
    font-size: 12px;
  }
  .shaper {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 14px 16px;
    margin-bottom: 24px;
  }
  .shaprow {
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }
  .taskin {
    flex: 1;
    resize: vertical;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    color: var(--text);
    padding: 8px 10px;
    font: inherit;
  }
  .btn {
    background: var(--panel-2);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    color: var(--text);
    padding: 8px 14px;
    cursor: pointer;
    white-space: nowrap;
  }
  .btn:hover:not(:disabled) {
    border-color: var(--accent);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .btn.primary {
    margin-top: 12px;
    border-color: var(--accent);
    color: var(--accent);
  }
  .sublabel {
    font-size: 12px;
    color: var(--muted);
    margin: 14px 0 6px;
  }
  .recs,
  .qs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
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
    gap: 3px;
  }
  .qttl {
    font-size: 13px;
  }
  .qin {
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    color: var(--text);
    padding: 6px 9px;
    font: inherit;
  }
</style>
