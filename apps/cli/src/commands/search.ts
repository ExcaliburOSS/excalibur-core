import {
  PermissionEngine,
  provisionSearxng,
  removeSearxng,
  resolveLocalSearxng,
  searxngContainerState,
  searxngReachable,
  webSearch,
  type SearchProviderId,
} from '@excalibur/agent-runtime';
import { DEFAULT_SEARCH_PROVIDER } from '@excalibur/shared';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { readRawConfig, writeRawConfig } from '../lib/config-file';
import { loadConfigContext } from '../lib/context';

const PROVIDER_NAMES: SearchProviderId[] | ['auto', ...SearchProviderId[]] = [
  'auto',
  'searxng',
  'duckduckgo',
  'exa',
  'tavily',
  'brave',
];
const PAID_PROVIDERS = new Set(['exa', 'tavily', 'brave']);

/**
 * `excalibur search` — web search from the CLI. FREE and UNLIMITED by default:
 * `auto` resolves a local SearXNG (private, unmetered) when reachable, otherwise
 * keyless DuckDuckGo (works anywhere). Subcommands:
 *  - `serve`   — provision/start/stop the local SearXNG container (Docker).
 *  - `provider`— show or set the backend (auto|searxng|duckduckgo|exa|tavily|brave).
 * Paid backends are 100% opt-in BYOK (set `search.apiKeyEnv`). Honors the same
 * network governance as the agent's `web_search` tool.
 */
export function registerSearchCommand(program: Command, deps: CliDeps): void {
  const search = program
    .command('search')
    .description('search the web (free + unlimited by default: local SearXNG → DuckDuckGo)')
    .argument('[query...]', 'search query')
    .option('--json', 'machine-readable JSON output')
    .option('-n, --max <n>', 'maximum number of results')
    .action(async (query: string[], options: { json?: boolean; max?: string }) => {
      if (query.length === 0) {
        deps.ui.info(deps.t('search.usage'));
        return;
      }
      await runSearch(deps, query.join(' '), options);
    });

  search
    .command('serve')
    .description('provision/start a local SearXNG (unlimited + private) via Docker')
    .option('--stop', 'stop and remove the local SearXNG container')
    .option('--status', 'show the local SearXNG status')
    .option('-y, --yes', 'skip the confirmation prompt')
    .action(async (options: { stop?: boolean; status?: boolean; yes?: boolean }) => {
      await serveSearxng(deps, options);
    });

  search
    .command('provider')
    .description('show or set the search backend (auto|searxng|duckduckgo|exa|tavily|brave)')
    .argument('[name]', 'backend to set')
    .action((name: string | undefined) => {
      setProvider(deps, name);
    });
}

async function runSearch(
  deps: CliDeps,
  query: string,
  options: { json?: boolean; max?: string },
): Promise<void> {
  const { config } = loadConfigContext(deps.cwd());
  const searchCfg = config.search ?? DEFAULT_SEARCH_PROVIDER;
  const engine = new PermissionEngine(config.permissions);
  if (!engine.checkNetwork().allowed) {
    deps.ui.error(deps.t('search.network-off'));
    return;
  }

  const type = searchCfg.type ?? 'auto';
  let searxngUrl: string | null = null;
  if (type === 'auto' || type === 'searxng') {
    searxngUrl = await resolveLocalSearxng({
      autoStart: searchCfg.manageSearxng ?? true,
      ...(searchCfg.baseUrl !== undefined ? { baseUrl: searchCfg.baseUrl } : {}),
    });
  }
  const apiKey =
    searchCfg.apiKeyEnv !== undefined ? (deps.env[searchCfg.apiKeyEnv] ?? undefined) : undefined;
  const max =
    options.max !== undefined && Number.isFinite(Number(options.max))
      ? Math.max(1, Math.floor(Number(options.max)))
      : undefined;

  try {
    const res = await webSearch(query, {
      config: searchCfg,
      ...(max !== undefined ? { maxResults: max } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
      searxngUrl,
      allowHost: (url) => engine.isUrlAllowed(url),
    });
    if (options.json === true) {
      deps.ui.json(res);
      return;
    }
    if (res.results.length === 0) {
      deps.ui.info(deps.t('search.no-results', { query, provider: res.provider }));
      return;
    }
    deps.ui.heading(deps.t('search.results-heading', { query, provider: res.provider }));
    res.results.forEach((r, index) => {
      deps.ui.write(`${index + 1}. ${pc.bold(r.title)}`);
      deps.ui.write(`   ${pc.cyan(r.url)}`);
      if (r.snippet.length > 0) {
        deps.ui.write(`   ${pc.dim(r.snippet)}`);
      }
    });
  } catch (error) {
    deps.ui.error(
      deps.t('search.error', { message: error instanceof Error ? error.message : String(error) }),
    );
  }
}

async function serveSearxng(
  deps: CliDeps,
  options: { stop?: boolean; status?: boolean; yes?: boolean },
): Promise<void> {
  const state = searxngContainerState();

  if (options.status === true) {
    const reachable = state === 'running' ? await searxngReachable() : false;
    deps.ui.info(
      deps.t('search.serve-status', {
        state,
        reachable: reachable ? deps.t('search.reachable-yes') : deps.t('search.reachable-no'),
      }),
    );
    return;
  }

  if (options.stop === true) {
    const removed = removeSearxng();
    deps.ui.success(removed ? deps.t('search.serve-stopped') : deps.t('search.serve-not-running'));
    return;
  }

  if (state === 'docker-unavailable') {
    deps.ui.warn(deps.t('search.serve-no-docker'));
    return;
  }
  const proceed = await deps.ui.confirm(deps.t('search.serve-consent'), {
    yes: options.yes === true,
    defaultYes: false,
  });
  if (!proceed) {
    deps.ui.info(deps.t('search.serve-cancelled'));
    return;
  }
  deps.ui.info(deps.t('search.serve-starting'));
  const result = await provisionSearxng({});
  if (result.ok) {
    deps.ui.success(deps.t('search.serve-up', { url: result.baseUrl }));
  } else {
    deps.ui.error(result.message);
  }
}

function setProvider(deps: CliDeps, name: string | undefined): void {
  const repoRoot = deps.cwd();
  const raw = readRawConfig(repoRoot);
  const section =
    typeof raw['search'] === 'object' && raw['search'] !== null
      ? (raw['search'] as Record<string, unknown>)
      : {};
  const current = typeof section['type'] === 'string' ? section['type'] : 'auto';

  if (name === undefined) {
    deps.ui.info(deps.t('search.provider-current', { name: current }));
    return;
  }
  if (!(PROVIDER_NAMES as string[]).includes(name)) {
    throw new CliUsageError(
      deps.t('search.provider-unknown', { name, names: PROVIDER_NAMES.join(', ') }),
    );
  }
  section['type'] = name;
  raw['search'] = section;
  writeRawConfig(repoRoot, raw);
  deps.ui.success(deps.t('search.provider-set', { name }));
  if (PAID_PROVIDERS.has(name)) {
    deps.ui.info(deps.t('search.provider-byok-hint'));
  }
}
