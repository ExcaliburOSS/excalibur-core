import {
  browserReaderFrom,
  executeNativeTool,
  guardUntrustedContent,
  PermissionEngine,
  webFetch,
  type ToolExecutionContext,
} from '@excalibur/agent-runtime';
import { RunManager } from '@excalibur/core';
import type { Command } from 'commander';
import type { CliDeps } from '../deps';
import { CliUsageError } from '../errors';
import { readRawConfig, writeRawConfig } from '../lib/config-file';
import { loadConfigContext } from '../lib/context';

const SCRAPE_PROVIDERS = ['firecrawl', 'jina', 'browserbase'] as const;
const PAID_PROVIDERS = new Set(['firecrawl', 'browserbase']);

/**
 * `excalibur web` — fetch a URL through the full tier pipeline (hosted reader →
 * local browser → free Tier-1) and print the clean markdown, noting the tier
 * that served it. `web reader` configures the OPTIONAL hosted scrape backend
 * (F5, BYOK). Honors the network policy + SSRF floor (via the tool executor).
 */
export function registerWebCommand(program: Command, deps: CliDeps): void {
  const web = program
    .command('web')
    .description('fetch a URL as clean markdown (hosted reader → local browser → free Tier-1)')
    .argument('[url...]', 'absolute http(s) URL to fetch')
    .option('--json', 'machine-readable JSON output')
    .option('-n, --max <n>', 'cap on returned characters')
    .action(async (urlParts: string[], options: { json?: boolean; max?: string }) => {
      if (urlParts.length === 0) {
        deps.ui.info(deps.t('web.usage'));
        return;
      }
      await runWeb(deps, urlParts[0] as string, options);
    });

  web
    .command('reader')
    .description('show or set the hosted scrape reader (firecrawl|jina|browserbase)')
    .argument('[name]', 'hosted reader to set')
    .action((name: string | undefined) => {
      setReader(deps, name);
    });

  web
    .command('scan')
    .description('fetch a URL and dry-run the prompt-injection scanner (no model)')
    .argument('<url>', 'absolute http(s) URL to scan')
    .option('--json', 'machine-readable JSON output')
    .action(async (url: string, options: { json?: boolean }) => {
      await scanUrl(deps, url, options);
    });

  web
    .command('provenance')
    .description("show a run's audited web provenance + egress (defaults to the latest run)")
    .argument('[runId]', 'run id')
    .option('--json', 'machine-readable JSON output')
    .action((runId: string | undefined, options: { json?: boolean }) => {
      showProvenance(deps, runId, options);
    });
}

function showProvenance(
  deps: CliDeps,
  runId: string | undefined,
  options: { json?: boolean },
): void {
  const runManager = new RunManager(deps.cwd());
  const run = runId !== undefined ? runManager.getRun(runId) : runManager.latestRun();
  if (run === null) {
    deps.ui.info(deps.t('web.prov-noruns'));
    return;
  }
  const events = runManager.readEvents(run.id);
  const provenance = events.filter((e) => e.type === 'provenance').map((e) => e.payload);
  const egress = events.filter((e) => e.type === 'network_egress').map((e) => e.payload);
  if (options.json === true) {
    deps.ui.json({ runId: run.id, provenance, egress });
    return;
  }
  if (provenance.length === 0 && egress.length === 0) {
    deps.ui.info(deps.t('web.prov-none'));
    return;
  }
  if (egress.length > 0) {
    deps.ui.table(
      [deps.t('web.col-tool'), deps.t('web.col-target'), deps.t('web.col-decision')],
      egress.map((p) => [
        String(p['tool'] ?? ''),
        String(p['target'] ?? '').slice(0, 60),
        String(p['decision'] ?? ''),
      ]),
    );
  }
  if (provenance.length > 0) {
    deps.ui.table(
      [
        deps.t('web.col-source'),
        deps.t('web.col-verdict'),
        deps.t('web.col-hash'),
        deps.t('web.col-target'),
      ],
      provenance.map((p) => [
        String(p['source'] ?? ''),
        String(p['verdict'] ?? ''),
        String(p['contentHash'] ?? '').slice(0, 12),
        String(p['url'] ?? '').slice(0, 50),
      ]),
    );
  }
}

async function scanUrl(deps: CliDeps, url: string, options: { json?: boolean }): Promise<void> {
  const { config } = loadConfigContext(deps.cwd());
  const engine = new PermissionEngine(config.permissions);
  if (!engine.checkUrl(url).allowed) {
    deps.ui.error(deps.t('web.scan-denied'));
    return;
  }
  let markdown: string;
  try {
    markdown = (await webFetch(url, { maxChars: 50_000 })).markdown;
  } catch (error) {
    deps.ui.error(
      deps.t('web.error', { message: error instanceof Error ? error.message : String(error) }),
    );
    return;
  }
  const guard = guardUntrustedContent(markdown, 'web_fetch', url, { enabled: true });
  if (options.json === true) {
    deps.ui.json({
      url,
      verdict: guard.verdict,
      score: guard.score,
      contentHash: guard.contentHash,
      signals: guard.signals.map((s) => s.category),
    });
    return;
  }
  deps.ui.info(
    deps.t('web.scan-result', {
      verdict: guard.verdict,
      score: String(guard.score),
      hash: guard.contentHash.slice(0, 12),
    }),
  );
  if (guard.signals.length > 0) {
    deps.ui.info(
      deps.t('web.scan-signals', { signals: guard.signals.map((s) => s.category).join(', ') }),
    );
  }
}

async function runWeb(
  deps: CliDeps,
  url: string,
  options: { json?: boolean; max?: string },
): Promise<void> {
  const repoRoot = deps.cwd();
  const { config } = loadConfigContext(repoRoot);
  const engine = new PermissionEngine(config.permissions);
  const max =
    options.max !== undefined && Number.isFinite(Number(options.max))
      ? Math.max(1, Math.floor(Number(options.max)))
      : undefined;
  const browserCfg = config.browser;
  const ctx: ToolExecutionContext = {
    workdir: repoRoot,
    config,
    permissions: engine,
    scrapeEnv: deps.env,
    ...(browserCfg?.enabled === true
      ? {
          browserReader: browserReaderFrom({
            command: browserCfg.command,
            args: browserCfg.args,
            timeoutMs: browserCfg.timeoutMs,
          }),
        }
      : {}),
  };
  const result = await executeNativeTool(
    'web_fetch',
    { url, ...(max !== undefined ? { maxChars: max } : {}) },
    ctx,
  );
  if (options.json === true) {
    deps.ui.json({ ok: result.ok, result: result.result });
    return;
  }
  if (!result.ok) {
    deps.ui.error(result.result);
    return;
  }
  deps.ui.write(result.result);
}

function setReader(deps: CliDeps, name: string | undefined): void {
  const repoRoot = deps.cwd();
  const raw = readRawConfig(repoRoot);
  const section =
    typeof raw['scrape'] === 'object' && raw['scrape'] !== null
      ? (raw['scrape'] as Record<string, unknown>)
      : {};
  const current = typeof section['provider'] === 'string' ? section['provider'] : undefined;

  if (name === undefined) {
    if (current === undefined) {
      deps.ui.info(deps.t('web.reader-none'));
    } else {
      const env = typeof section['apiKeyEnv'] === 'string' ? section['apiKeyEnv'] : '(unset)';
      deps.ui.info(deps.t('web.reader-current', { name: current, env }));
    }
    return;
  }
  if (!(SCRAPE_PROVIDERS as readonly string[]).includes(name)) {
    throw new CliUsageError(
      deps.t('web.reader-unknown', { name, names: SCRAPE_PROVIDERS.join(', ') }),
    );
  }
  section['provider'] = name;
  raw['scrape'] = section;
  writeRawConfig(repoRoot, raw);
  deps.ui.success(deps.t('web.reader-set', { name }));
  if (PAID_PROVIDERS.has(name)) {
    deps.ui.info(deps.t('web.reader-byok-hint'));
  } else {
    deps.ui.info(deps.t('web.reader-jina-hint'));
  }
}
