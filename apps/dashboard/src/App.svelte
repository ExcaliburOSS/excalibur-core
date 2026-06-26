<script lang="ts">
  import { createRouter } from './lib/router.svelte';
  import { t } from './lib/i18n';
  import Board from './pages/Board.svelte';
  import WorkItem from './pages/WorkItem.svelte';
  import Runs from './pages/Runs.svelte';
  import Insights from './pages/Insights.svelte';
  import Orchestrations from './pages/Orchestrations.svelte';
  import Chronogram from './pages/Chronogram.svelte';
  import Plans from './pages/Plans.svelte';
  import Scope from './pages/Scope.svelte';
  import Missions from './pages/Missions.svelte';
  import Sessions from './pages/Sessions.svelte';
  import Scheduler from './pages/Scheduler.svelte';
  import Threads from './pages/Threads.svelte';
  import RunDetail from './pages/RunDetail.svelte';

  const router = createRouter();

  const NAV: { href: string; key: string; match: string[] }[] = [
    { href: '#/', key: 'nav.board', match: ['board', 'workItem'] },
    { href: '#/runs', key: 'nav.runs', match: ['runs', 'run'] },
    { href: '#/orchestrations', key: 'nav.orchestrations', match: ['orchestrations'] },
    { href: '#/insights', key: 'nav.insights', match: ['insights'] },
    { href: '#/plans', key: 'nav.plans', match: ['plans'] },
    { href: '#/scope', key: 'nav.scope', match: ['scope'] },
    { href: '#/missions', key: 'nav.missions', match: ['missions'] },
    { href: '#/sessions', key: 'nav.sessions', match: ['sessions', 'session'] },
    { href: '#/scheduler', key: 'nav.scheduler', match: ['scheduler'] },
    { href: '#/threads', key: 'nav.threads', match: ['threads'] },
  ];
</script>

<div class="shell">
  <header class="topbar">
    <a class="brand" href="#/">
      <span class="sword" aria-hidden="true">⚔</span>
      <span class="word">Excalibur</span>
      <span class="tag faint">{t('app.tagline')}</span>
    </a>
    <nav>
      {#each NAV as item (item.href)}
        {@const active = item.match.includes(router.current.name)}
        <a href={item.href} class:active aria-current={active ? 'page' : undefined}>
          {t(item.key)}
        </a>
      {/each}
    </nav>
  </header>

  <main>
    {#if router.current.name === 'board'}
      <Board />
    {:else if router.current.name === 'workItem'}
      <WorkItem key={router.current.params.key ?? ''} />
    {:else if router.current.name === 'run'}
      <RunDetail id={router.current.params.id ?? ''} />
    {:else if router.current.name === 'runs'}
      <Runs />
    {:else if router.current.name === 'insights'}
      <Insights />
    {:else if router.current.name === 'orchestrations'}
      <Orchestrations />
    {:else if router.current.name === 'orchestration'}
      <Chronogram id={router.current.params.id ?? ''} />
    {:else if router.current.name === 'plans'}
      <Plans />
    {:else if router.current.name === 'scope'}
      <Scope />
    {:else if router.current.name === 'missions'}
      <Missions />
    {:else if router.current.name === 'sessions' || router.current.name === 'session'}
      <Sessions id={router.current.params.id ?? ''} />
    {:else if router.current.name === 'scheduler'}
      <Scheduler />
    {:else if router.current.name === 'threads'}
      <Threads />
    {:else}
      <div class="empty">{t('common.notFound')}</div>
    {/if}
  </main>
</div>

<style>
  .shell {
    max-width: 1280px;
    margin: 0 auto;
    padding: 0 20px 64px;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px 0;
    border-bottom: 1px solid var(--line);
    position: sticky;
    top: 0;
    background: var(--bg);
    z-index: 10;
  }
  .brand {
    display: flex;
    align-items: baseline;
    gap: 10px;
    color: var(--text);
  }
  .brand:hover {
    text-decoration: none;
  }
  .sword {
    color: var(--accent);
    font-size: 18px;
  }
  .word {
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .tag {
    font-size: 12px;
  }
  nav {
    display: flex;
    gap: 4px;
  }
  nav a {
    color: var(--muted);
    padding: 6px 12px;
    border-radius: var(--radius-sm);
    font-weight: 500;
  }
  nav a:hover {
    color: var(--text);
    background: var(--panel);
    text-decoration: none;
  }
  nav a.active {
    color: var(--text);
    background: var(--panel-2);
  }
  main {
    padding-top: 24px;
  }
  .empty {
    padding: 64px 0;
    text-align: center;
    color: var(--muted);
  }
</style>
