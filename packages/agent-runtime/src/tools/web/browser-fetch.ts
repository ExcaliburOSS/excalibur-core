import { McpClient } from '../../mcp/mcp-client';
import { htmlToMarkdown } from './extract-html';
import type { TierReader, WebFetchResult } from './fetch';

/**
 * Tier-2 LOCAL browser reader (F4) — renders a page with a headless Chromium via
 * Playwright MCP (`npx @playwright/mcp`, spawned on-demand over the EXISTING MCP
 * stdio client) and returns the rendered HTML as markdown. This is the free,
 * opt-in escalation for JS-only / anti-bot pages that the Tier-1 fetch can't read.
 *
 * It is a no-op (returns null / throws {@link BrowserUnavailableError}) when the
 * browser is not enabled/installed, so the pipeline gracefully falls back to
 * Tier-1. The MCP `connect` is injectable so the orchestration is unit-tested
 * offline without spawning a real browser.
 */

export class BrowserUnavailableError extends Error {}

/** The minimal MCP client surface the browser tier needs (McpClient satisfies it). */
export interface BrowserMcpClient {
  listTools(): Promise<Array<{ name: string }>>;
  callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
  close(): void;
}

export type BrowserConnector = (opts: {
  command: string;
  args: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}) => Promise<BrowserMcpClient>;

export interface BrowserRenderOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  command?: string;
  args?: string[];
  /** Injectable MCP connect (defaults to the real stdio Playwright MCP). */
  connect?: BrowserConnector;
}

const DEFAULT_COMMAND = 'npx';
const DEFAULT_ARGS = ['-y', '@playwright/mcp@latest', '--headless', '--isolated'];
const OUTER_HTML = '() => document.documentElement.outerHTML';

const defaultConnect: BrowserConnector = async (opts) =>
  (await McpClient.connect({
    command: opts.command,
    args: opts.args,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  })) as unknown as BrowserMcpClient;

function flatten(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('\n')
    .trim();
}

function findTool(tools: Array<{ name: string }>, pattern: RegExp): string | undefined {
  return tools.find((t) => pattern.test(t.name))?.name;
}

/**
 * Renders `url` with the local browser and returns it as a {@link WebFetchResult}
 * (`meta.tier = 'browser'`). Returns null when no Playwright MCP tool surface is
 * usable; throws {@link BrowserUnavailableError} when the server can't start.
 */
export async function renderWithBrowser(
  url: string,
  opts: BrowserRenderOptions = {},
): Promise<WebFetchResult | null> {
  const connect = opts.connect ?? defaultConnect;
  let client: BrowserMcpClient;
  try {
    client = await connect({
      command: opts.command ?? DEFAULT_COMMAND,
      args: opts.args ?? DEFAULT_ARGS,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  } catch (error) {
    throw new BrowserUnavailableError(
      `Local browser unavailable (run \`excalibur browser enable\`): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const tools = await client.listTools();
    const navigate = findTool(tools, /navigate/i);
    if (navigate === undefined) {
      return null;
    }
    await client.callTool(navigate, { url });

    // Prefer real HTML (→ defuddle markdown); fall back to the a11y snapshot text.
    const evaluate = findTool(tools, /evaluate/i);
    if (evaluate !== undefined) {
      const evaluated = await client.callTool(evaluate, {
        function: OUTER_HTML,
        expression: OUTER_HTML,
      });
      const html = flatten(evaluated);
      if (html.includes('<') && html.includes('>')) {
        const { title, markdown } = await htmlToMarkdown(html, url);
        return browserResult(url, title.length > 0 ? title : url, markdown);
      }
    }
    const snapshot = findTool(tools, /snapshot|accessib|text|content|markdown/i);
    if (snapshot !== undefined) {
      const snap = await client.callTool(snapshot, {});
      const text = flatten(snap);
      if (text.length > 0) {
        return browserResult(url, url, text);
      }
    }
    return null;
  } finally {
    try {
      client.close();
    } catch {
      /* already closed */
    }
  }
}

function browserResult(url: string, title: string, markdown: string): WebFetchResult {
  return {
    url,
    title,
    markdown,
    text: markdown,
    meta: {
      status: 200,
      contentType: 'text/html',
      fetchedAt: new Date().toISOString(),
      bytes: Buffer.byteLength(markdown),
      truncated: false,
      tier: 'browser',
    },
  };
}

/** Builds a {@link TierReader} bound to the browser config (for the fetch pipeline). */
export function browserReaderFrom(config: {
  command?: string;
  args?: string[];
  timeoutMs?: number;
}): TierReader {
  return (url, ctx) =>
    renderWithBrowser(url, {
      ...(config.command !== undefined ? { command: config.command } : {}),
      ...(config.args !== undefined ? { args: config.args } : {}),
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
}
