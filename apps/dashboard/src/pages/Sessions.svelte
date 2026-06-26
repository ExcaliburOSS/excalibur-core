<script lang="ts">
  import { fetchSessions, fetchSession, ApiError } from '../lib/api';
  import type { SessionSummary, SessionDetail } from '../lib/contracts';
  import { t } from '../lib/i18n';

  // DASH1 — read-only Sessions view. `id` empty → the list; `id` set → one
  // session's transcript (drill-in via #/sessions/:id). A single $effect reloads
  // whenever the route id changes.
  let { id = '' }: { id?: string } = $props();

  let list = $state<SessionSummary[]>([]);
  let detail = $state<SessionDetail | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  $effect(() => {
    const sessionId = id;
    loading = true;
    error = null;
    detail = null;
    const load = sessionId.length > 0 ? fetchSession(sessionId).then((d) => (detail = d)) : fetchSessions().then((r) => (list = r.sessions));
    load
      .catch((e) => {
        error = e instanceof ApiError ? `${e.status} · ${e.message}` : String(e);
      })
      .finally(() => (loading = false));
  });

  const when = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  };
  const cost = (c: number | null | undefined): string =>
    c === null || c === undefined ? '' : `$${(c / 100).toFixed(4)}`;
</script>

{#if id.length > 0}
  <!-- Detail: one session's transcript -->
  <a class="back" href="#/sessions">{t('sessions.back')}</a>
  {#if loading}
    <div class="state muted">{t('common.loading')}</div>
  {:else if error !== null}
    <div class="state bad">{t('common.error')}: {error}</div>
  {:else if detail === null}
    <div class="state muted">{t('sessions.notFound')}</div>
  {:else}
    <h1>{detail.title}</h1>
    <div class="meta faint">
      <span class="st st-{detail.status}">{t('session.status.' + detail.status)}</span>
      <span>{t('sessions.turns', { n: detail.turnCount })}</span>
      {#if detail.lastModel}<span>{detail.lastModel}</span>{/if}
      <span>{when(detail.updatedAt)}</span>
    </div>

    <h2>{t('sessions.transcript')}</h2>
    {#if detail.turns.length === 0}
      <div class="muted small">{t('sessions.transcriptEmpty')}</div>
    {:else}
      <ul class="turns">
        {#each detail.turns as turn (turn.id)}
          <li class="turn turn-{turn.role}">
            <div class="thead faint">
              <span class="role">{turn.role}</span>
              <span class="kind">{turn.kind}</span>
              {#if turn.model}<span class="model">{turn.model}</span>{/if}
              {#if cost(turn.costCents)}<span class="cost">{cost(turn.costCents)}</span>{/if}
              <span class="at">{when(turn.at)}</span>
            </div>
            <pre class="text">{turn.text}</pre>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
{:else}
  <!-- List -->
  <h1>{t('sessions.title')}</h1>
  <p class="subtitle">{t('sessions.subtitle')}</p>
  {#if loading}
    <div class="state muted">{t('common.loading')}</div>
  {:else if error !== null}
    <div class="state bad">{t('common.error')}: {error}</div>
  {:else if list.length === 0}
    <div class="muted small">{t('sessions.empty')}</div>
  {:else}
    <ul class="list">
      {#each list as s (s.id)}
        <li class="item">
          <a class="row" href={`#/sessions/${encodeURIComponent(s.id)}`}>
            <span class="ttl">{s.title}</span>
            <span class="st st-{s.status}">{t('session.status.' + s.status)}</span>
            <span class="faint count">{t('sessions.turns', { n: s.turnCount })}</span>
            {#if s.lastModel}<span class="faint model">{s.lastModel}</span>{/if}
            <span class="faint when">{when(s.updatedAt)}</span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
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
  h2 {
    font-size: 15px;
    margin: 20px 0 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--line);
  }
  .state {
    padding: 48px 0;
    text-align: center;
  }
  .back {
    display: inline-block;
    margin-bottom: 12px;
    color: var(--muted);
    font-size: 13px;
  }
  .meta {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    font-size: 12px;
    margin-bottom: 8px;
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
    gap: 10px;
    width: 100%;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
    color: var(--text);
  }
  .row:hover {
    border-color: var(--line-strong);
    text-decoration: none;
  }
  .ttl {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count,
  .model,
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
  .st-active {
    color: var(--accent);
  }
  .turns {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .turn {
    background: var(--panel);
    border: 1px solid var(--line);
    border-left: 2px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
  }
  .turn-user {
    border-left-color: var(--accent);
  }
  .turn-assistant {
    border-left-color: var(--ok);
  }
  .thead {
    display: flex;
    gap: 10px;
    font-size: 11px;
    margin-bottom: 4px;
    flex-wrap: wrap;
  }
  .role {
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .text {
    margin: 0;
    white-space: pre-wrap;
    font-family: var(--mono);
    font-size: 12px;
    overflow-x: auto;
  }
  .small {
    font-size: 12px;
  }
</style>
