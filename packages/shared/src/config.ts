import { z } from 'zod';
import { autonomyLevelSchema } from './autonomy';
import {
  instructionSourceFormatSchema,
  instructionSourceScopeSchema,
  trustLevelSchema,
} from './instructions';

/**
 * `.excalibur/config.yaml` schema (OSS spec §10 + §14, work-items spec §6,
 * onboarding spec §2, ISD spec §6). Every section is optional: a repository
 * without `.excalibur/` must still work on defaults.
 */

/** Canonical detected commands (test/lint/typecheck/build). */
export const commandsConfigSchema = z.object({
  test: z.string().optional(),
  lint: z.string().optional(),
  typecheck: z.string().optional(),
  build: z.string().optional(),
});
export type CommandsConfig = z.infer<typeof commandsConfigSchema>;

const projectSectionSchema = z.object({
  name: z.string().optional(),
  packageManager: z.string().optional(),
  languages: z.array(z.string()).optional(),
  frameworks: z.array(z.string()).optional(),
  /** Accepted alias; normalized into the top-level `commands` section. */
  commands: commandsConfigSchema.optional(),
});

const safetySectionSchema = z.object({
  /** Safety preset id; `standard-safe` when unset (see DEFAULT_CONFIG). */
  preset: z.string().optional(),
});

const autonomySectionSchema = z.object({
  default: autonomyLevelSchema.optional(),
  paths: z.record(autonomyLevelSchema).optional(),
  allowFullAgentic: z.array(z.string()).optional(),
});

const workflowsSectionSchema = z.object({
  default: z.string().optional(),
  byTaskType: z.record(z.string()).optional(),
  byPath: z.record(z.string()).optional(),
});

const modelsSectionSchema = z.object({
  default: z.string().optional(),
  byRole: z.record(z.string()).optional(),
  byPath: z.record(z.string()).optional(),
});

/**
 * Network egress policy (real, enforced — closes the old decorative
 * `tools.network` flag). Governs BOTH the web tools (`web_fetch`/`web_search`/…)
 * and network-capable shell commands (curl/wget/…). SSRF protection (loopback /
 * RFC1918 / link-local / cloud-metadata) is ALWAYS enforced regardless of mode —
 * it never blocks the public web, only dangerous internal targets.
 *
 * - `on` (default): any PUBLIC host (still SSRF-guarded) — the agent can research
 *   the web out of the box; `approval: ask` adds a soft gate (skipped under the
 *   session auto-accept), and the SSRF floor is the hard safety boundary.
 * - `allowlist`: only hosts matching `allowedDomains` (minimatch globs).
 * - `off`: no agent-initiated egress at all (lockdown).
 */
export const networkPolicySchema = z.object({
  mode: z.enum(['off', 'allowlist', 'on']).default('on'),
  /** Host globs permitted when `mode='allowlist'`, e.g. "*.github.com". */
  allowedDomains: z.array(z.string()).optional(),
  /** Hosts explicitly allowed to be private/loopback (e.g. a local SearXNG). */
  allowPrivateHosts: z.array(z.string()).optional(),
  /** Approval posture when a URL is permitted by mode: ask each time, or auto. */
  approval: z.enum(['ask', 'auto']).default('ask'),
});
export type NetworkPolicy = z.infer<typeof networkPolicySchema>;

/**
 * Network TRANSPORT config (distinct from `permissions.network`, which is the
 * egress POLICY). Corporate proxy + custom CA support: every outbound request
 * (web fetch, model gateway, MCP, enterprise-sync) funnels through Node's global
 * `fetch`, so the CLI installs one global undici dispatcher from this config +
 * the standard env vars at startup. Env vars (`HTTP(S)_PROXY`/`NO_PROXY`/
 * `NODE_EXTRA_CA_CERTS`) always WIN over config; config fills the gaps.
 */
export const networkTransportSchema = z.object({
  proxy: z
    .object({
      /** Proxy URL for http:// targets (fallback when HTTP_PROXY is unset). */
      http: z.string().optional(),
      /** Proxy URL for https:// targets (fallback when HTTPS_PROXY is unset). */
      https: z.string().optional(),
      /** Comma-separated no-proxy host list (fallback when NO_PROXY is unset). */
      noProxy: z.string().optional(),
    })
    .optional(),
  tls: z
    .object({
      /** Path to a PEM bundle of extra CA certs (corporate root CA / MITM proxy). */
      caFile: z.string().optional(),
      /** Set false ONLY to accept self-signed certs (insecure; warned loudly). */
      rejectUnauthorized: z.boolean().optional(),
    })
    .optional(),
});
export type NetworkTransportConfig = z.infer<typeof networkTransportSchema>;

export const permissionsSectionSchema = z.object({
  tools: z.record(z.union([z.boolean(), z.literal('ask')])).optional(),
  blockedPaths: z.array(z.string()).optional(),
  allowedCommands: z.array(z.string()).optional(),
  /**
   * Command globs that are HARD-DENIED even if allowlisted (deny beats allow) —
   * a safety net for dangerous commands (e.g. `rm -rf *`, `git push --force`).
   * Matched (minimatch) against the normalized command.
   */
  deniedCommands: z.array(z.string()).optional(),
  network: networkPolicySchema.optional(),
});

const approvalsSectionSchema = z.object({
  requiredFor: z
    .object({
      paths: z.array(z.string()).optional(),
      commands: z.array(z.string()).optional(),
      phases: z.array(z.string()).optional(),
    })
    .optional(),
  /**
   * Session auto-accept preference (minimum-friction mode). When `true`, the
   * interactive shell never prompts for edit/command approval (blocked paths
   * stay hard-denied). `undefined` = not chosen yet → the shell asks ONCE at
   * session start and persists the answer here, so it never asks again.
   */
  auto: z.boolean().optional(),
});

const contextSectionSchema = z.object({
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});

const agentsSectionSchema = z.object({ default: z.string().optional() }).catchall(z.unknown());

/**
 * `compaction:` — context compaction knobs (plan §"Compactación de contexto").
 * Automatic + config-only (no plugin SDK). Field-tested defaults; each field
 * defaults independently so a partial block is valid. The core compaction engine
 * (`@excalibur/core`) consumes this exact shape.
 */
export const compactionConfigSchema = z.object({
  /** Master switch (default true; disable with one flag). */
  enabled: z.boolean().default(true),
  /** Tokens held back from the window for the reply + headroom. */
  reserveTokens: z.number().int().positive().default(16384),
  /** Tokens of the recent tail preserved verbatim (cut only at turn limits). */
  keepRecentTokens: z.number().int().positive().default(20000),
  /**
   * Which model summarizes: `active` (the main session model — the DEFAULT,
   * since the summary becomes durable context so quality matters most), `cheap`
   * (opt-in: the fast pairing model for lower cost/latency), or a concrete id.
   */
  summarizerModel: z.string().min(1).default('active'),
  /** Prune stale tool outputs before summarizing. */
  pruneToolOutputs: z.boolean().default(true),
});
export type CompactionConfig = z.infer<typeof compactionConfigSchema>;

/** Default compaction config when `.excalibur/config.yaml` has no `compaction:` block. */
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
  summarizerModel: 'active',
  pruneToolOutputs: true,
};

/**
 * `mcp:` — Model Context Protocol servers whose tools the agent may call. Each
 * is EITHER a local subprocess (`command` + args, NO shell) OR a remote server
 * (`url`, Streamable HTTP, with optional auth `headers`). Absent → MCP off.
 * API keys/secrets belong in the process environment (inherited by a local
 * server), NOT in this file; `env` is for non-secret overrides only. For a
 * remote server, prefer an env-var reference in `headers` over a literal secret.
 */
/** Per-MCP-server network sandbox (F6): an egress allowlist ON TOP of the SSRF floor. */
const mcpServerEgressSchema = z.object({
  /** Host globs this server's REMOTE endpoint may match (beyond the SSRF floor). */
  allowedDomains: z.array(z.string()).optional(),
  /** Hosts this server may reach even if private/loopback (e.g. a local gateway). */
  allowPrivateHosts: z.array(z.string()).optional(),
});

/** Auth for a REMOTE MCP server (F6). `oauth` is reserved for the DCR/PKCE flow. */
const mcpServerAuthSchema = z
  .object({
    /** none · bearerEnv (static token from an env var NAME) · oauth (reserved: DCR/PKCE). */
    type: z.enum(['none', 'bearerEnv', 'oauth']).default('none'),
    /** Env var NAME holding a static bearer token (BYOK; never the token itself). */
    bearerEnv: z.string().min(1).optional(),
    /** OAuth overrides (normally discovered via RFC 8414/9728); reserved. */
    authorizationUrl: z.string().url().optional(),
    tokenUrl: z.string().url().optional(),
    scopes: z.array(z.string()).optional(),
  })
  .refine((a) => a.type !== 'bearerEnv' || a.bearerEnv !== undefined, {
    message: 'auth.type "bearerEnv" requires auth.bearerEnv (the env var NAME holding the token)',
  });

const mcpServerConfigSchema = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    /** Remote MCP endpoint (Streamable HTTP). Set this OR `command`. */
    url: z.string().url().optional(),
    /** Headers sent on every remote request, e.g. `{ Authorization: "Bearer …" }`. */
    headers: z.record(z.string()).optional(),
    /**
     * Trust posture (F6): `trusted` = no per-call confirm (output still
     * injection-scanned); `untrusted`/`prompt` = confirm each call. Defaults to
     * `prompt` (applied by the consumer) — external tools are confirmed unless
     * you vouch for the server.
     */
    trust: z.enum(['trusted', 'untrusted', 'prompt']).optional(),
    /** Explicit read-only tool names (else the server's `readOnlyHint` decides). */
    readOnlyTools: z.array(z.string()).optional(),
    /** Explicit mutating tool names (else the server's `destructiveHint` decides). */
    mutatingTools: z.array(z.string()).optional(),
    /** Expose this server's READ-ONLY tools to read-only/research roles (default true). */
    allowReadOnlyRoles: z.boolean().optional(),
    /** Per-server network sandbox (reuses checkUrl / the SSRF floor). */
    egress: mcpServerEgressSchema.optional(),
    /** Auth for a remote server. */
    auth: mcpServerAuthSchema.optional(),
  })
  .refine((s) => (s.command !== undefined) !== (s.url !== undefined), {
    message: 'an MCP server needs EXACTLY ONE of `command` (local stdio) or `url` (remote http)',
  });
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export const mcpSectionSchema = z.object({
  servers: z.record(mcpServerConfigSchema).optional(),
  /**
   * Scan every MCP tool result for prompt-injection BEFORE it enters the model
   * context (F6): `off` · `warn` (annotate + event, the consumer default) ·
   * `strict` (replace a flagged result with a safe summary). Structural,
   * language-agnostic.
   */
  injectionScan: z.enum(['off', 'warn', 'strict']).optional(),
});

/**
 * `sandbox:` — run agent shell commands inside an ephemeral Docker container
 * (OSS spec §18, M3). Off by default. When `enabled`, `run_command` executes in
 * an isolated container (only the repo mounted, no host secrets/network) instead
 * of on the host. `image` must carry the repo's toolchain (default Alpine has no
 * node/pnpm), so this is an advanced opt-in.
 */
export const sandboxConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Container image (must have `sh` + the repo's toolchain). */
  image: z.string().min(1).optional(),
  memoryMb: z.number().int().positive().optional(),
  cpus: z.number().positive().optional(),
  /** Allow network inside the sandbox (default false). */
  network: z.boolean().optional(),
});
export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;

/**
 * `lsp:` — feed REAL compiler diagnostics from a Language Server to the agent
 * after each edit, so it self-corrects on the next turn (P1.10 / M3). On by
 * default but INERT unless a server binary for the edited language is on PATH
 * (graceful: no server installed → behaves exactly as before, no spawn). v1
 * verifies TypeScript/JavaScript (`typescript-language-server --stdio`); other
 * languages work if their server is installed. `servers` overrides the default
 * command per language id (`typescript`/`python`/`go`/`rust`).
 */
export const lspConfigSchema = z.object({
  enabled: z.boolean().default(true),
  servers: z
    .record(z.object({ command: z.string().min(1), args: z.array(z.string()).optional() }))
    .optional(),
  /** Per-edit wait for the language server to publish diagnostics (ms). */
  diagnosticsTimeoutMs: z.number().int().positive().default(1500),
  /**
   * After the first diagnostics arrive, how long to wait for a LATER wave —
   * tsserver emits a syntactic (often empty) pass, then the semantic errors.
   * Higher = more reliable on a loaded machine; lower = snappier per-edit.
   */
  diagnosticsSettleMs: z.number().int().positive().default(400),
  /** One-time cold-start budget for the server's initialize + project load (ms). */
  serverStartTimeoutMs: z.number().int().positive().default(8000),
});
export type LspConfig = z.infer<typeof lspConfigSchema>;

/** Default LSP config when `.excalibur/config.yaml` has no `lsp:` block. */
export const DEFAULT_LSP_CONFIG: LspConfig = {
  enabled: true,
  diagnosticsTimeoutMs: 1500,
  diagnosticsSettleMs: 400,
  serverStartTimeoutMs: 8000,
};

/**
 * `search:` — the web-search backend for the `web_search` tool (F3). FREE and
 * UNLIMITED by default. `type: 'auto'` (the default) resolves the best free
 * backend at search time: a local SearXNG instance when one is reachable
 * (unlimited + private), otherwise keyless DuckDuckGo (works on any machine,
 * best-effort). Paid backends (`exa`/`tavily`/`brave`) are 100% opt-in BYOK —
 * used ONLY when `type` is set to them explicitly, NEVER by `auto`.
 *
 * - `apiKeyEnv`: the NAME of the environment variable holding the key (BYOK;
 *   never the key itself, never committed) — required for the paid backends.
 * - `baseUrl`: endpoint override (e.g. a remote/self-hosted SearXNG).
 * - `manageSearxng`: let Excalibur auto-provision/start a local SearXNG
 *   container via Docker (the unlimited+private upgrade); off → probe-only.
 */
export const searchProviderSchema = z.object({
  type: z.enum(['auto', 'searxng', 'duckduckgo', 'exa', 'tavily', 'brave']).default('auto'),
  /** Env var NAME holding the API key for a paid backend (BYOK, not the key). */
  apiKeyEnv: z.string().min(1).optional(),
  /** Endpoint override (e.g. a remote SearXNG instance). */
  baseUrl: z.string().url().optional(),
  /** Maximum results returned per search. */
  maxResults: z.number().int().positive().max(25).default(8),
  /** Auto-provision/start a local SearXNG container via Docker when available. */
  manageSearxng: z.boolean().default(true),
});
export type SearchProviderConfig = z.infer<typeof searchProviderSchema>;

/** Default search config: free + unlimited, zero-config (auto → SearXNG | DuckDuckGo). */
export const DEFAULT_SEARCH_PROVIDER: SearchProviderConfig = {
  type: 'auto',
  maxResults: 8,
  manageSearxng: true,
};

/**
 * `browser:` — Tier-2 LOCAL headless browser (F4). FREE but 100% OPT-IN: nothing
 * is downloaded until `excalibur browser enable` runs `playwright install
 * chromium`. When `enabled`, `web_fetch` AUTO-ESCALATES to the local browser on a
 * 403/429/JS-only/thin-content Tier-1 result, and `web_extract` prefers the
 * rendered page. Runs via Playwright MCP (`npx @playwright/mcp`) over the existing
 * MCP client. Chromium is NEVER auto-installed and NEVER bundled.
 */
export const browserConfigSchema = z.object({
  /** Master opt-in switch. False/absent → escalation never fires (Tier-1 only). */
  enabled: z.boolean().default(false),
  /** Command for the Playwright MCP server (advanced override). */
  command: z.string().min(1).default('npx'),
  args: z.array(z.string()).default(['-y', '@playwright/mcp@latest', '--headless', '--isolated']),
  /** Per-render wall-clock budget (ms) before falling back to the Tier-1 result. */
  timeoutMs: z.number().int().positive().default(30_000),
  /** Markdown shorter than this from Tier-1 counts as "thin" → escalate. */
  thinContentChars: z.number().int().positive().default(200),
});
export type BrowserConfig = z.infer<typeof browserConfigSchema>;

/** Default browser config: present but OFF (Tier-1 only until the user opts in). */
export const DEFAULT_BROWSER_CONFIG: BrowserConfig = {
  enabled: false,
  command: 'npx',
  args: ['-y', '@playwright/mcp@latest', '--headless', '--isolated'],
  timeoutMs: 30_000,
  thinContentChars: 200,
};

/**
 * `crawl:` — knobs for `web_crawl`'s transversal polite-fetch layer (F4). All
 * free, on by default; the SSRF floor + network policy still apply per page.
 */
export const crawlConfigSchema = z.object({
  /** Honor robots.txt allow/deny + Crawl-delay (default true; never silently off). */
  respectRobots: z.boolean().default(true),
  /** Min delay between requests to the SAME host, ms (token-bucket spacing). */
  perHostDelayMs: z.number().int().nonnegative().default(1000),
  /** TTL for the on-disk ETag/markdown cache, ms (default 24h). */
  cacheTtlMs: z.number().int().positive().default(86_400_000),
  /** Max cached entries before LRU prune. */
  cacheMaxEntries: z.number().int().positive().default(2000),
  /** Hard upper bound on pages a single crawl may fetch (anti-runaway). */
  maxPages: z.number().int().positive().max(200).default(10),
});
export type CrawlConfig = z.infer<typeof crawlConfigSchema>;

/** Default crawl config: polite + bounded. */
export const DEFAULT_CRAWL_CONFIG: CrawlConfig = {
  respectRobots: true,
  perHostDelayMs: 1000,
  cacheTtlMs: 86_400_000,
  cacheMaxEntries: 2000,
  maxPages: 10,
};

/**
 * `scrape:` — OPTIONAL hosted page readers for `web_fetch` (F5). 100% opt-in,
 * BYOK, PAID. ABSENT BY DEFAULT → `web_fetch` stays fully free on the in-bundle
 * Tier-1 fetch (F2) + the local-browser Tier-2 (F4). When set, the hosted reader
 * is a PREFERRED escalation tier: `prefer` tries it FIRST (zero-setup, JS-rendered
 * / stealth) and falls back to the free tiers on failure; `fallback` uses it ONLY
 * after the free fetch fails. The key is read from the env var NAMED by
 * `apiKeyEnv` (never the key, never committed). Jina has a key-less best-effort
 * mode (`jinaKeyless`).
 */
export const scrapeProviderSchema = z.object({
  provider: z.enum(['firecrawl', 'jina', 'browserbase']),
  /** Env var NAME holding the BYOK API key (not the key itself). */
  apiKeyEnv: z.string().min(1).optional(),
  /** Endpoint override (e.g. a self-hosted Firecrawl, or a regional base). */
  baseUrl: z.string().url().optional(),
  /** `prefer` = hosted first then free fallback; `fallback` = only if free fails. */
  mode: z.enum(['prefer', 'fallback']).default('prefer'),
  /** Per hosted-call timeout (ms) — hosted renderers are slower than a raw GET. */
  timeoutMs: z.number().int().positive().max(120_000).default(30_000),
  /** Allow Jina's key-less best-effort endpoint when no key is set (default true). */
  jinaKeyless: z.boolean().default(true),
});
export type ScrapeProviderConfig = z.infer<typeof scrapeProviderSchema>;

/**
 * `research:` — the native deep-research pipeline (F7). FREE + UNLIMITED (uses the
 * same `search` backend: SearXNG → DuckDuckGo). All bounds are cheap, governable
 * caps; the pipeline is always SSRF/network-policy governed.
 */
export const researchSectionSchema = z.object({
  /** Max distinct sources fetched per research pass. */
  maxSources: z.number().int().positive().max(12).default(5),
  /** Sub-queries the planner may fan out. */
  maxSubQueries: z.number().int().positive().max(6).default(3),
  /** Blind adversarial verifier sub-agents voting per claim (odd → no ties). */
  votes: z.number().int().min(1).max(5).default(3),
  /** When true, an unverified/uncited research claim can feed the Claim Ledger. */
  ledger: z.boolean().default(true),
});
export type ResearchConfig = z.infer<typeof researchSectionSchema>;

/** Default research config: free, bounded, 3-vote verification. */
export const DEFAULT_RESEARCH: ResearchConfig = {
  maxSources: 5,
  maxSubQueries: 3,
  votes: 3,
  ledger: true,
};

/**
 * `web.injection:` — governance for UNTRUSTED inbound web/MCP content (F8). The
 * scanner + data-fence are ON by default and free (pure heuristics, no deps, no
 * network). `blockOnMalicious` is OFF by default (annotate + quarantine the model
 * context, but don't fail the run) — opt-in for hardened setups.
 */
export const webInjectionConfigSchema = z.object({
  /** Master switch for the scanner + data-fence (default true). */
  enabled: z.boolean().default(true),
  /** Quarantine malicious content out of context AND (future) gate the run. Default false. */
  blockOnMalicious: z.boolean().default(false),
  /** Score (0–100) at/above which a source is `malicious` (quarantined). */
  maliciousThreshold: z.number().int().min(0).max(100).default(70),
  /** Score (0–100) at/above which a source is `suspicious` (fenced, content kept). */
  suspiciousThreshold: z.number().int().min(0).max(100).default(30),
  /** Strip zero-width / bidi / hidden text before it reaches the model (default true). */
  stripHiddenText: z.boolean().default(true),
});
export type WebInjectionConfig = z.infer<typeof webInjectionConfigSchema>;

export const webConfigSchema = z.object({
  injection: webInjectionConfigSchema.optional(),
});
export type WebConfig = z.infer<typeof webConfigSchema>;

/** Default web-governance config: scanner on, non-blocking. */
export const DEFAULT_WEB_CONFIG: WebConfig = {
  injection: {
    enabled: true,
    blockOnMalicious: false,
    maliciousThreshold: 70,
    suspiciousThreshold: 30,
    stripHiddenText: true,
  },
};

const instructionSourceRefSchema = z.object({
  path: z.string().min(1),
  format: instructionSourceFormatSchema.optional(),
  scope: instructionSourceScopeSchema.optional(),
  enabled: z.boolean().optional(),
  /** User-global sources are referenced locally only, never synced/copied. */
  localOnly: z.boolean().optional(),
});

const skillSourceRefSchema = z.object({
  path: z.string().min(1),
  scope: z.enum(['project', 'user_global']).optional(),
  enabled: z.boolean().optional(),
  trustLevel: trustLevelSchema.optional(),
});

/** Presentation settings for the TUI (theme preset, arthurian flavour). */
/** A 6-digit hex color (e.g. `#5BC8FF`) — the format every palette color uses. */
const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be a 6-digit hex color like "#5BC8FF"');

/**
 * Custom theme overrides (P1.13): any subset of the palette's 14 colors, merged
 * OVER the resolved base theme (`ui.theme`). Lets a user tweak one accent or
 * author a full palette without forking — `mode` still comes from the base.
 */
const customThemeSchema = z
  .object({
    accent: hexColorSchema.optional(),
    accentDim: hexColorSchema.optional(),
    success: hexColorSchema.optional(),
    warn: hexColorSchema.optional(),
    danger: hexColorSchema.optional(),
    text: hexColorSchema.optional(),
    muted: hexColorSchema.optional(),
    rail: hexColorSchema.optional(),
    diffAddFg: hexColorSchema.optional(),
    diffDelFg: hexColorSchema.optional(),
    diffAddBg: hexColorSchema.optional(),
    diffDelBg: hexColorSchema.optional(),
    diffAddWordBg: hexColorSchema.optional(),
    diffDelWordBg: hexColorSchema.optional(),
  })
  .strict();

const uiSectionSchema = z
  .object({
    /** Named theme: `auto` (follow terminal) | `dark` | `light` | `daltonized` | `high-contrast`. */
    theme: z.enum(['auto', 'dark', 'light', 'daltonized', 'high-contrast']).optional(),
    /** Custom color overrides merged over the named theme (P1.13). */
    customTheme: customThemeSchema.optional(),
    /** Caption flavour for phase spinners: `plain` (default) | `arthurian`. */
    flavor: z.enum(['plain', 'arthurian']).optional(),
    /** Auto-start the read-only web dashboard with the interactive shell (default true). */
    dashboard: z.boolean().optional(),
  })
  .optional();

/** Adversarial Verification Mesh policy (proportional by default; governable here). */
const verificationSectionSchema = z
  .object({
    /** off = never · auto = proportional to risk (default) · always = ≥1 lens on any change. */
    mesh: z.enum(['off', 'auto', 'always']).optional(),
  })
  .optional();

/** Hard budget cap (plan P2.3) — autonomy you can cap by dollars. */
const budgetSectionSchema = z
  .object({
    /**
     * Maximum model spend for a SINGLE run, in US dollars. When the run's
     * accumulated cost reaches this ceiling, the next model call is DENIED and
     * the run ends `failed` (needs-raise) — Excalibur does not just track spend,
     * it stops at the cap. Omit/`null` for no cap (the default).
     */
    maxRunUsd: z.number().positive().nullable().optional(),
  })
  .optional();

const baseExcaliburConfigSchema = z.object({
  version: z.number().int().optional(),
  /** Spoken UI locale for generated chrome/prose (`en`|`es`); auto-detected when absent. */
  language: z.string().optional(),
  /** TUI presentation (theme preset, flavour). */
  ui: uiSectionSchema,
  /** Adversarial Verification Mesh policy. */
  verification: verificationSectionSchema,
  /** Hard per-run budget cap (deny-by-dollars). */
  budget: budgetSectionSchema,
  project: projectSectionSchema.optional(),
  /** Top-level canonical commands; `project.commands` is normalized into it. */
  commands: commandsConfigSchema.optional(),
  safety: safetySectionSchema.optional(),
  workflowDefaults: z.record(z.string()).optional(),
  autonomyDefaults: z.record(autonomyLevelSchema).optional(),
  autonomy: autonomySectionSchema.optional(),
  workflows: workflowsSectionSchema.optional(),
  models: modelsSectionSchema.optional(),
  permissions: permissionsSectionSchema.optional(),
  /** Network transport (corporate proxy + custom CA); see networkTransportSchema. */
  network: networkTransportSchema.optional(),
  approvals: approvalsSectionSchema.optional(),
  context: contextSectionSchema.optional(),
  integrations: z.record(z.record(z.string())).optional(),
  agents: agentsSectionSchema.optional(),
  compaction: compactionConfigSchema.optional(),
  mcp: mcpSectionSchema.optional(),
  sandbox: sandboxConfigSchema.optional(),
  lsp: lspConfigSchema.optional(),
  /** Per-edit formatters (P1.9): auto-format a file after the agent writes it. */
  format: z.object({ enabled: z.boolean().optional() }).optional(),
  search: searchProviderSchema.optional(),
  browser: browserConfigSchema.optional(),
  crawl: crawlConfigSchema.optional(),
  scrape: scrapeProviderSchema.optional(),
  research: researchSectionSchema.optional(),
  web: webConfigSchema.optional(),
  instructions: z.object({ sources: z.array(instructionSourceRefSchema).optional() }).optional(),
  skills: z.object({ sources: z.array(skillSourceRefSchema).optional() }).optional(),
});

/**
 * Parsing normalizes the `project.commands` alias into the canonical
 * top-level `commands` section. On per-key conflicts the top-level value wins.
 */
export const excaliburConfigSchema = baseExcaliburConfigSchema.transform((config) => {
  const projectCommands = config.project?.commands;
  if (!projectCommands) {
    return config;
  }
  return { ...config, commands: { ...projectCommands, ...config.commands } };
});
export type ExcaliburConfig = z.infer<typeof excaliburConfigSchema>;

/** OSS spec §17 default blocked paths (minimatch patterns, `dot: true`). */
export const DEFAULT_BLOCKED_PATHS: ReadonlyArray<string> = [
  '.env',
  '.env.*',
  '**/*.pem',
  '**/*.key',
  '**/secrets/**',
  '**/.ssh/**',
  'node_modules/**',
  'dist/**',
  'build/**',
];

/**
 * Default network policy: the agent CAN reach the public web out of the box
 * (`mode: 'on'`), gated by a soft confirmation (`approval: 'ask'`, skipped under
 * session auto-accept) and the always-on SSRF floor (private/loopback/metadata
 * hard-denied). Set `mode: 'off'` for a network lockdown.
 */
export const DEFAULT_NETWORK_POLICY: NetworkPolicy = { mode: 'on', approval: 'ask' };

/** OSS spec §17 default allowed commands (common package-script invocations). */
export const DEFAULT_ALLOWED_COMMANDS: ReadonlyArray<string> = [
  'npm test',
  'npm run test',
  'npm run typecheck',
  'npm run lint',
  'pnpm test',
  'pnpm typecheck',
  'pnpm lint',
  'yarn test',
];

/**
 * Baseline configuration used when `.excalibur/config.yaml` is missing and as
 * the merge base in `loadExcaliburConfig`. Mirrors onboarding spec §2:
 * `standard-safe` preset, command→workflow/autonomy defaults, conservative
 * tool permissions (read-only tools allowed, mutating tools ask, network off).
 */
export const DEFAULT_CONFIG: ExcaliburConfig = {
  version: 1,
  commands: {},
  safety: { preset: 'standard-safe' },
  workflowDefaults: {
    ask: 'ask-repo',
    review: 'review-only',
    patch: 'propose-patch',
    run: 'standard-feature',
    careful: 'structured-feature',
    discovery: 'discovery',
  },
  autonomyDefaults: {
    ask: 1,
    review: 0,
    patch: 2,
    run: 3,
    careful: 4,
    discovery: 0,
  },
  workflows: {
    default: 'standard-feature',
    byTaskType: {
      bugfix: 'fast-fix',
      feature: 'standard-feature',
      refactor: 'safe-refactor',
      migration: 'migration',
      security: 'security-review',
    },
  },
  models: { default: 'mock' },
  agents: { default: 'native' },
  compaction: DEFAULT_COMPACTION_CONFIG,
  lsp: DEFAULT_LSP_CONFIG,
  search: DEFAULT_SEARCH_PROVIDER,
  research: DEFAULT_RESEARCH,
  web: DEFAULT_WEB_CONFIG,
  permissions: {
    tools: {
      read_file: true,
      list_files: true,
      search_code: true,
      git_diff: true,
      write_file: 'ask',
      apply_patch: 'ask',
      run_command: 'ask',
      create_branch: 'ask',
      run_tests: 'ask',
      web_fetch: 'ask',
      web_search: 'ask',
      web_extract: 'ask',
      web_crawl: 'ask',
    },
    blockedPaths: [...DEFAULT_BLOCKED_PATHS],
    allowedCommands: [...DEFAULT_ALLOWED_COMMANDS],
    network: DEFAULT_NETWORK_POLICY,
  },
  instructions: { sources: [] },
  skills: { sources: [] },
};
