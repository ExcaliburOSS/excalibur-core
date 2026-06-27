<script lang="ts">
  import { createRouter, navigate } from './lib/router.svelte';
  import { t } from './lib/i18n';
  import Board from './pages/Board.svelte';
  import WorkItem from './pages/WorkItem.svelte';
  import Runs from './pages/Runs.svelte';
  import Insights from './pages/Insights.svelte';
  import Orchestrations from './pages/Orchestrations.svelte';
  import Chronogram from './pages/Chronogram.svelte';
  import Plans from './pages/Plans.svelte';
  import Sprints from './pages/Sprints.svelte';
  import Scope from './pages/Scope.svelte';
  import Missions from './pages/Missions.svelte';
  import Sessions from './pages/Sessions.svelte';
  import Scheduler from './pages/Scheduler.svelte';
  import Threads from './pages/Threads.svelte';
  import RunDetail from './pages/RunDetail.svelte';
  import Search from './pages/Search.svelte';
  import Activity from './pages/Activity.svelte';
  import BudgetMeter from './lib/BudgetMeter.svelte';

  const router = createRouter();

  // Task-first IA: everything orbits work items. Four destinations — the board
  // (the hub), plans, a unified Activity hub (runs · missions · orchestrations ·
  // threads · scheduler · sessions, each linked back to its task), and portfolio
  // metrics. Scope lives inside a work item; search lives in the top bar.
  const NAV: { href: string; key: string; match: string[] }[] = [
    { href: '#/', key: 'nav.board', match: ['board', 'workItem'] },
    { href: '#/plans', key: 'nav.plans', match: ['plans'] },
    { href: '#/sprints', key: 'nav.sprints', match: ['sprints', 'sprint'] },
    {
      href: '#/activity',
      key: 'nav.activity',
      match: [
        'activity',
        'runs',
        'run',
        'orchestrations',
        'orchestration',
        'missions',
        'sessions',
        'session',
        'scheduler',
        'threads',
        'scope',
      ],
    },
    { href: '#/insights', key: 'nav.insights', match: ['insights'] },
  ];

  let query = $state('');
  function submitSearch(e: SubmitEvent): void {
    e.preventDefault();
    const q = query.trim();
    navigate(q.length > 0 ? `/search?q=${encodeURIComponent(q)}` : '/search');
  }
</script>

<div class="shell">
  <header class="topbar">
    <a class="brand" href="#/" aria-label="Excalibur">
      <svg
        class="logo"
        viewBox="0 0 596 159"
        role="img"
        aria-hidden="true"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M151.762 48.3633H115.492V70.1016H150.707V82.9336H115.492V113.168H151.762V126H101.84V35.5312H151.762V48.3633ZM184.867 95.1211L164.359 68.9297H180.062L192.777 85.5703L205.727 68.9297H221.898L200.805 95.1211L225.238 126H209.535L192.777 104.672L175.609 126H159.496L184.867 95.1211ZM276.273 71.3906V88.9102C273.266 85.2383 270.57 82.7188 268.188 81.3516C265.844 79.9453 263.09 79.2422 259.926 79.2422C254.965 79.2422 250.844 80.9805 247.562 84.457C244.281 87.9336 242.641 92.2891 242.641 97.5234C242.641 102.875 244.223 107.27 247.387 110.707C250.59 114.145 254.672 115.863 259.633 115.863C262.797 115.863 265.59 115.18 268.012 113.812C270.355 112.484 273.109 109.906 276.273 106.078V123.48C270.922 126.254 265.57 127.641 260.219 127.641C251.391 127.641 244.008 124.789 238.07 119.086C232.133 113.344 229.164 106.215 229.164 97.6992C229.164 89.1836 232.172 81.9961 238.188 76.1367C244.203 70.2773 251.586 67.3477 260.336 67.3477C265.961 67.3477 271.273 68.6953 276.273 71.3906ZM331.117 68.9297H344.359V126H331.117V120.023C325.688 125.102 319.848 127.641 313.598 127.641C305.707 127.641 299.184 124.789 294.027 119.086C288.91 113.266 286.352 106 286.352 97.2891C286.352 88.7344 288.91 81.6055 294.027 75.9023C299.145 70.1992 305.551 67.3477 313.246 67.3477C319.887 67.3477 325.844 70.082 331.117 75.5508V68.9297ZM299.828 97.2891C299.828 102.758 301.293 107.211 304.223 110.648C307.23 114.125 311.02 115.863 315.59 115.863C320.473 115.863 324.418 114.184 327.426 110.824C330.434 107.348 331.938 102.934 331.938 97.582C331.938 92.2305 330.434 87.8164 327.426 84.3398C324.418 80.9414 320.512 79.2422 315.707 79.2422C311.176 79.2422 307.387 80.9609 304.34 84.3984C301.332 87.875 299.828 92.1719 299.828 97.2891ZM374.184 27.0352V126H361V27.0352H374.184ZM404.066 68.9297V126H390.883V68.9297H404.066ZM388.891 45.1992C388.891 42.8945 389.73 40.9023 391.41 39.2227C393.09 37.543 395.102 36.7031 397.445 36.7031C399.828 36.7031 401.859 37.543 403.539 39.2227C405.219 40.8633 406.059 42.875 406.059 45.2578C406.059 47.6406 405.219 49.6719 403.539 51.3516C401.898 53.0313 399.887 53.8711 397.504 53.8711C395.121 53.8711 393.09 53.0313 391.41 51.3516C389.73 49.6719 388.891 47.6211 388.891 45.1992ZM433.949 27.0352V75.5508C439.223 70.082 445.199 67.3477 451.879 67.3477C459.574 67.3477 465.98 70.2188 471.098 75.9609C476.215 81.6641 478.773 88.7734 478.773 97.2891C478.773 106.078 476.195 113.344 471.039 119.086C465.922 124.789 459.457 127.641 451.645 127.641C445.043 127.641 439.145 125.102 433.949 120.023V126H420.766V27.0352H433.949ZM465.297 97.875C465.297 92.4062 463.812 87.9531 460.844 84.5156C457.836 81 454.066 79.2422 449.535 79.2422C444.691 79.2422 440.746 80.9414 437.699 84.3398C434.691 87.6992 433.188 92.0742 433.188 97.4648C433.188 103.012 434.672 107.445 437.641 110.766C440.609 114.164 444.516 115.863 449.359 115.863C453.93 115.863 457.719 114.164 460.727 110.766C463.773 107.328 465.297 103.031 465.297 97.875ZM505.902 68.9297V101.684C505.902 111.137 509.633 115.863 517.094 115.863C524.555 115.863 528.285 111.137 528.285 101.684V68.9297H541.469V101.977C541.469 106.547 540.902 110.492 539.77 113.812C538.676 116.781 536.781 119.457 534.086 121.84C529.633 125.707 523.969 127.641 517.094 127.641C510.258 127.641 504.613 125.707 500.16 121.84C497.426 119.457 495.492 116.781 494.359 113.812C493.266 111.156 492.719 107.211 492.719 101.977V68.9297H505.902ZM558.109 68.9297H571.293V74.0273C573.715 71.4883 575.863 69.75 577.738 68.8125C579.652 67.8359 581.918 67.3477 584.535 67.3477C588.012 67.3477 591.645 68.4805 595.434 70.7461L589.398 82.8164C586.898 81.0195 584.457 80.1211 582.074 80.1211C574.887 80.1211 571.293 85.5508 571.293 96.4102V126H558.109V68.9297Z"
          fill="currentColor"
        />
        <rect x="27.6172" y="27.5928" width="21.3403" height="96.4706" fill="currentColor" />
        <rect
          width="14.7692"
          height="75.6682"
          transform="matrix(-0.00791251 0.999969 -0.999976 -0.00694983 75.7832 124.589)"
          fill="currentColor"
        />
        <line
          x1="38.1597"
          y1="47.5928"
          x2="38.1597"
          y2="124.063"
          stroke="var(--accent)"
          stroke-width="2"
        />
        <path d="M38.2735 12L48.9443 27.6201H27.6027L38.2735 12Z" fill="var(--accent)" />
      </svg>
    </a>

    <nav aria-label="Primary">
      {#each NAV as item (item.href)}
        {@const active = item.match.includes(router.current.name)}
        <a href={item.href} class:active aria-current={active ? 'page' : undefined}>
          {t(item.key)}
        </a>
      {/each}
    </nav>

    <div class="right">
      <form class="search" onsubmit={submitSearch} role="search">
        <svg class="ic" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2" />
          <line
            x1="16.5"
            y1="16.5"
            x2="21"
            y2="21"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
        <input bind:value={query} placeholder={t('search.bar')} aria-label={t('search.title')} />
      </form>
      <BudgetMeter />
    </div>
  </header>

  <main class="page" data-route={router.current.name}>
    {#key router.current.name + (router.current.params.key ?? router.current.params.id ?? '')}
      <div class="page-in">
        {#if router.current.name === 'board'}
          <Board />
        {:else if router.current.name === 'workItem'}
          <WorkItem key={router.current.params.key ?? ''} />
        {:else if router.current.name === 'activity'}
          <Activity />
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
        {:else if router.current.name === 'plan'}
          <Plans id={router.current.params.id ?? ''} />
        {:else if router.current.name === 'sprints'}
          <Sprints />
        {:else if router.current.name === 'sprint'}
          <Sprints id={router.current.params.id ?? ''} />
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
        {:else if router.current.name === 'search'}
          <Search />
        {:else}
          <div class="empty">{t('common.notFound')}</div>
        {/if}
      </div>
    {/key}
  </main>
</div>

<style>
  .shell {
    max-width: 1320px;
    margin: 0 auto;
    padding: 0 24px 72px;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 14px 0;
    margin-bottom: 4px;
    position: sticky;
    top: 0;
    z-index: 20;
    background: color-mix(in srgb, var(--bg) 78%, transparent);
    backdrop-filter: blur(14px) saturate(1.2);
    -webkit-backdrop-filter: blur(14px) saturate(1.2);
    border-bottom: 1px solid var(--line);
  }
  /* A faint cobalt hairline of light along the bottom edge of the bar. */
  .topbar::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 1px;
    background: linear-gradient(
      90deg,
      transparent,
      rgba(77, 163, 255, 0.5),
      rgba(103, 217, 255, 0.25),
      transparent
    );
  }
  .brand {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }
  .logo {
    height: 22px;
    width: auto;
    color: var(--text);
    transition:
      filter var(--transition),
      transform var(--transition);
  }
  .brand:hover .logo {
    filter: drop-shadow(0 0 10px rgba(77, 163, 255, 0.5));
  }

  nav {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 1;
    flex-wrap: wrap;
  }
  nav a {
    color: var(--muted);
    padding: 7px 14px;
    border-radius: var(--radius-sm);
    font-weight: 550;
    position: relative;
    transition:
      color var(--transition),
      background var(--transition);
  }
  nav a:hover {
    color: var(--text);
    background: var(--panel);
  }
  nav a.active {
    color: var(--text);
    background: var(--accent-soft);
  }
  /* An underline pip marks the active destination. */
  nav a.active::after {
    content: '';
    position: absolute;
    left: 14px;
    right: 14px;
    bottom: 2px;
    height: 2px;
    border-radius: 2px;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
  }

  .right {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 7px;
    background: var(--bg-2);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0 12px;
    height: 34px;
    width: 200px;
    transition:
      border-color var(--transition),
      box-shadow var(--transition),
      width var(--transition);
  }
  .search:focus-within {
    border-color: var(--accent);
    box-shadow: var(--ring);
    width: 240px;
  }
  .search .ic {
    width: 15px;
    height: 15px;
    color: var(--faint);
    flex-shrink: 0;
  }
  .search input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text);
    font-size: 13px;
  }
  .search input::placeholder {
    color: var(--faint);
  }

  main {
    padding-top: 28px;
  }
  .page-in {
    animation: page-in 360ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  @keyframes page-in {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .page-in {
      animation: none;
    }
  }
  .empty {
    padding: 80px 0;
    text-align: center;
    color: var(--muted);
  }

  @media (max-width: 860px) {
    .shell {
      padding: 0 14px 56px;
    }
    .topbar {
      flex-wrap: wrap;
      gap: 10px 14px;
    }
    nav {
      order: 3;
      width: 100%;
      flex: none;
      gap: 0;
    }
    .right {
      margin-left: auto;
    }
    .search {
      width: 150px;
    }
    .search:focus-within {
      width: 180px;
    }
  }
</style>
