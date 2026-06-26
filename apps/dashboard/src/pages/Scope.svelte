<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchHealth, fetchScope, startRun, ApiError } from '../lib/api';
  import type { ScopeMapView } from '../lib/contracts';
  import { navigate } from '../lib/router.svelte';
  import { t } from '../lib/i18n';

  // AO9-4 — read-only "Understand-first" scope view. Mirrors the Plans shaper:
  // gate on `serve --write` (the scope compute needs the configured model), then
  // a task → POST /api/scope → render the ScopeMap (subsystems, exists/missing,
  // risks, open questions). A run can be started straight from a scoped task.
  let writable = $state(false);
  let taskInput = $state('');
  let map = $state<ScopeMapView | null>(null);
  let scoping = $state(false);
  let starting = $state(false);
  let error = $state<string | null>(null);
  let scopedEmpty = $state(false);

  onMount(() => {
    fetchHealth()
      .then((h) => (writable = h.write))
      .catch(() => (writable = false));
  });

  async function doScope(): Promise<void> {
    const task = taskInput.trim();
    if (task.length === 0 || scoping) return;
    scoping = true;
    error = null;
    map = null;
    scopedEmpty = false;
    try {
      const result = await fetchScope(task);
      if (result === null) scopedEmpty = true;
      else map = result;
    } catch (e) {
      error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
    } finally {
      scoping = false;
    }
  }

  async function doStartRun(): Promise<void> {
    const task = taskInput.trim();
    if (task.length === 0 || starting) return;
    starting = true;
    error = null;
    try {
      const { runId } = await startRun({ task });
      navigate(`/runs/${runId}`);
    } catch (e) {
      error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
      starting = false;
    }
  }
</script>

<h1>{t('scope.title')}</h1>
<p class="subtitle">{t('scope.subtitle')}</p>

<section class="panel">
  {#if !writable}
    <div class="muted small">{t('scope.needWrite')}</div>
  {:else}
    <div class="row">
      <textarea
        class="taskin"
        bind:value={taskInput}
        placeholder={t('scope.placeholder')}
        rows="2"
      ></textarea>
      <button class="btn" onclick={doScope} disabled={scoping || taskInput.trim().length === 0}>
        {scoping ? t('scope.running') : t('scope.run')}
      </button>
    </div>
    {#if error !== null}
      <div class="state bad small">{error}</div>
    {/if}
    {#if scopedEmpty}
      <div class="muted small">{t('scope.empty')}</div>
    {/if}
  {/if}
</section>

{#if map !== null}
  <section class="result">
    {#if map.summary.length > 0}
      <div class="sumlabel">{t('scope.summaryLabel')}</div>
      <p class="summary">{map.summary}</p>
    {/if}
    <div class="metaline faint">
      {t('scope.summaryLine', {
        subsystems: map.subsystems.length,
        risks: map.risks.length,
        questions: map.openQuestions.length,
      })}
    </div>

    <div class="sublabel">{t('scope.subsystems')}</div>
    <ul class="subs">
      {#each map.subsystems as s, i (i)}
        <li class="sub">
          <div class="subname">{s.subsystem}</div>
          {#if s.files.length > 0}
            <div class="kv"><span class="k">{t('scope.files')}</span> <code>{s.files.join(', ')}</code></div>
          {/if}
          {#if s.whatExists.length > 0}
            <div class="kv"><span class="k">{t('scope.exists')}</span> {s.whatExists}</div>
          {/if}
          {#if s.whatsMissing.length > 0}
            <div class="kv"><span class="k missing">{t('scope.missing')}</span> {s.whatsMissing}</div>
          {/if}
          {#if s.risks.length > 0}
            <ul class="risks">
              {#each s.risks as r, ri (ri)}
                <li>⚠ {r}</li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>

    {#if map.risks.length > 0}
      <div class="sublabel">{t('scope.risks')}</div>
      <ul class="toplist">
        {#each map.risks as r, i (i)}
          <li>{r}</li>
        {/each}
      </ul>
    {/if}

    {#if map.openQuestions.length > 0}
      <div class="sublabel">{t('scope.openQuestions')}</div>
      <ul class="toplist">
        {#each map.openQuestions as q, i (i)}
          <li>{q}</li>
        {/each}
      </ul>
    {/if}

    {#if writable}
      <button
        class="btn primary"
        onclick={doStartRun}
        disabled={starting || taskInput.trim().length === 0}
      >
        {starting ? t('planShape.starting') : t('scope.startRun')}
      </button>
    {/if}
  </section>
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
  .panel {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 14px 16px;
    margin-bottom: 20px;
  }
  .row {
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
    margin-top: 16px;
    border-color: var(--accent);
    color: var(--accent);
  }
  .result {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 16px 18px;
  }
  .sumlabel,
  .sublabel {
    font-size: 12px;
    color: var(--muted);
    margin: 16px 0 6px;
  }
  .sumlabel {
    margin-top: 0;
  }
  .summary {
    margin: 0;
    font-size: 14px;
  }
  .metaline {
    font-size: 11px;
    margin-top: 8px;
  }
  .subs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .sub {
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
  }
  .subname {
    font-weight: 600;
    margin-bottom: 6px;
  }
  .kv {
    font-size: 13px;
    margin: 3px 0;
  }
  .k {
    color: var(--muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    margin-right: 4px;
  }
  .k.missing {
    color: var(--accent);
  }
  .kv code {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text);
  }
  .risks {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .risks li {
    font-size: 12px;
    color: var(--warn, #e2b341);
  }
  .toplist {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
  }
  .small {
    font-size: 12px;
  }
  .state.bad {
    color: var(--bad);
    margin-top: 8px;
  }
</style>
