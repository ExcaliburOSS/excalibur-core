<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchInsights } from './api';
  import { t } from './i18n';

  // DASH6 — a live cost meter + notifier in the topbar. Polls /api/insights every
  // 5s; shows total spend, the running count and a pending-approval badge, and
  // (opt-in) fires a browser notification when a run completes or an approval
  // appears. Best-effort: a failed poll is silent and the meter keeps its values.
  let cost = $state(0);
  let running = $state(0);
  let pending = $state(0);
  let notifyOn = $state(false);
  // -1 = "not seen a poll yet" → never notify on the FIRST poll (avoids a burst
  // of notifications for pre-existing state when the page opens).
  let prevPending = -1;
  let prevCompleted = -1;

  function notify(title: string, body: string): void {
    if (notifyOn && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  }

  async function poll(): Promise<void> {
    try {
      const ins = await fetchInsights();
      cost = ins.totalCostCents;
      running = ins.byStatus['running'] ?? 0;
      pending = ins.byStatus['waiting_approval'] ?? 0;
      const completed = ins.byStatus['completed'] ?? 0;
      if (prevPending >= 0 && pending > prevPending) {
        notify(t('budget.notifyApprovalTitle'), t('budget.notifyApprovalBody'));
      }
      if (prevCompleted >= 0 && completed > prevCompleted) {
        notify(t('budget.notifyDoneTitle'), t('budget.notifyDoneBody'));
      }
      prevPending = pending;
      prevCompleted = completed;
    } catch {
      /* keep the last values on a transient failure */
    }
  }

  function toggleNotify(): void {
    if (notifyOn) {
      notifyOn = false;
      return;
    }
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      notifyOn = true;
    } else {
      void Notification.requestPermission().then((p) => (notifyOn = p === 'granted'));
    }
  }

  onMount(() => {
    void poll();
    const timer = setInterval(poll, 5000);
    return () => clearInterval(timer);
  });

  const dollars = $derived(`$${(cost / 100).toFixed(2)}`);
</script>

<div class="meter" title={t('budget.title')}>
  <span class="cost">{dollars}</span>
  {#if running > 0}
    <span class="pill running" title={t('budget.running')}>
      <span class="dot" aria-hidden="true"></span>{running}
    </span>
  {/if}
  {#if pending > 0}
    <a class="pill pending" href="#/runs" title={t('budget.pending')}>⚑ {pending}</a>
  {/if}
  <button
    class="bell"
    class:on={notifyOn}
    onclick={toggleNotify}
    title={notifyOn ? t('budget.notifyOn') : t('budget.notifyOff')}
    aria-pressed={notifyOn}
  >
    {notifyOn ? '🔔' : '🔕'}
  </button>
</div>

<style>
  .meter {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }
  .cost {
    font-family: var(--mono);
    color: var(--muted);
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--panel-2);
    font-size: 11px;
  }
  .pill.running {
    color: var(--accent);
  }
  .pill.pending {
    color: var(--warn, #e2b341);
  }
  .pill.pending:hover {
    text-decoration: none;
    background: var(--panel);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }
  .bell {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0 2px;
    font-size: 13px;
    opacity: 0.5;
    line-height: 1;
  }
  .bell.on {
    opacity: 1;
  }
</style>
