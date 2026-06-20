import {
  PermissionEngine,
  resolveLocalSearxng,
  webFetch,
  webSearch,
} from '@excalibur/agent-runtime';
import { runDeepResearch, type ResearchFetcher, type ResearchSearcher } from '@excalibur/core';
import { DEFAULT_RESEARCH, DEFAULT_SEARCH_PROVIDER } from '@excalibur/shared';
import type { CliDeps } from '../deps';
import { loadConfigContext, loadGatewayContext, requireConfiguredModel } from './context';

export interface ResearchFlowOptions {
  json?: boolean;
  maxSources?: number;
}

/**
 * Runs the native deep-research pipeline (F7) from the CLI / REPL: wires the real
 * model gateway + the free web search/fetch tiers into the core pipeline
 * (plan → search → fetch → adversarially verify → cited synthesis) and prints a
 * cited report. Governed by the network policy + SSRF floor on every fetch.
 */
export async function runResearchFlow(
  deps: CliDeps,
  question: string,
  options: ResearchFlowOptions = {},
): Promise<void> {
  const repoRoot = deps.cwd();
  const { config } = loadConfigContext(repoRoot);
  const gw = loadGatewayContext(repoRoot);
  requireConfiguredModel(gw, deps.t);

  const engine = new PermissionEngine(config.permissions);
  if (!engine.checkNetwork().allowed) {
    deps.ui.error(deps.t('research.network-off'));
    return;
  }

  const searchCfg = config.search ?? DEFAULT_SEARCH_PROVIDER;
  const researchCfg = config.research ?? DEFAULT_RESEARCH;
  const type = searchCfg.type ?? 'auto';
  const apiKey =
    searchCfg.apiKeyEnv !== undefined ? (deps.env[searchCfg.apiKeyEnv] ?? undefined) : undefined;
  let searxngUrl: string | null = null;
  if (type === 'auto' || type === 'searxng') {
    searxngUrl = await resolveLocalSearxng({
      autoStart: searchCfg.manageSearxng ?? true,
      ...(searchCfg.baseUrl !== undefined ? { baseUrl: searchCfg.baseUrl } : {}),
    });
  }

  const search: ResearchSearcher = async (q) => {
    const res = await webSearch(q, {
      config: searchCfg,
      maxResults: Math.min(20, researchCfg.maxSources * 2),
      ...(apiKey !== undefined ? { apiKey } : {}),
      searxngUrl,
      allowHost: (u) => engine.isUrlAllowed(u),
    });
    return res.results.map((r) => ({ url: r.url, title: r.title, snippet: r.snippet }));
  };
  const fetch: ResearchFetcher = async (url) => {
    if (!engine.checkUrl(url).allowed) return null;
    try {
      const page = await webFetch(url, { maxChars: 4000 });
      return { markdown: page.markdown, title: page.title };
    } catch {
      return null;
    }
  };

  deps.ui.info(deps.t('research.starting', { question }));
  const result = await runDeepResearch({
    question,
    gateway: gw.gateway,
    search,
    fetch,
    now: new Date().toISOString(),
    maxSources: options.maxSources ?? researchCfg.maxSources,
    maxSubQueries: researchCfg.maxSubQueries,
    votes: researchCfg.votes,
    provider: gw.providerName,
    onStage: (stage, detail) =>
      deps.ui.info(deps.t('research.stage', { stage, detail: detail ?? '' })),
  });

  if (options.json === true) {
    deps.ui.json(result);
    return;
  }
  deps.ui.write(result.report);
  const verified = result.claims.filter((c) => c.verified).length;
  deps.ui.info(
    deps.t('research.summary', {
      sources: String(result.sources.length),
      verified: String(verified),
      claims: String(result.claims.length),
    }),
  );
}
