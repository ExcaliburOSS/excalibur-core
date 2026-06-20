import { describe, expect, it, vi } from 'vitest';
import {
  BrowserUnavailableError,
  renderWithBrowser,
  type BrowserConnector,
  type BrowserMcpClient,
} from './browser-fetch';

const RENDERED_HTML =
  '<!doctype html><html><head><title>Rendered</title></head><body><article><h1>Heading</h1><p>JavaScript-rendered content that survives extraction.</p></article></body></html>';

function clientWith(tools: string[], handlers: Record<string, string>): BrowserMcpClient {
  return {
    listTools: async () => tools.map((name) => ({ name })),
    callTool: async (name) => ({ content: [{ type: 'text', text: handlers[name] ?? 'ok' }] }),
    close: vi.fn(),
  };
}

describe('renderWithBrowser', () => {
  it('navigates and converts evaluated HTML to markdown (tier=browser)', async () => {
    const client = clientWith(['browser_navigate', 'browser_evaluate'], {
      browser_evaluate: RENDERED_HTML,
    });
    const connect: BrowserConnector = async () => client;
    const res = await renderWithBrowser('http://93.184.216.34/', { connect });
    expect(res).not.toBeNull();
    expect(res?.meta.tier).toBe('browser');
    expect(res?.markdown).toContain('JavaScript-rendered content');
    expect(client.close).toHaveBeenCalled();
  });

  it('falls back to the snapshot tool when no evaluate tool exists', async () => {
    const client = clientWith(['browser_navigate', 'browser_snapshot'], {
      browser_snapshot: 'accessibility tree text content',
    });
    const connect: BrowserConnector = async () => client;
    const res = await renderWithBrowser('http://93.184.216.34/', { connect });
    expect(res?.markdown).toContain('accessibility tree text content');
  });

  it('returns null when no navigate tool is available', async () => {
    const connect: BrowserConnector = async () => clientWith(['unrelated'], {});
    expect(await renderWithBrowser('http://93.184.216.34/', { connect })).toBeNull();
  });

  it('throws BrowserUnavailableError when the server cannot start', async () => {
    const connect: BrowserConnector = async () => {
      throw new Error('spawn ENOENT');
    };
    await expect(renderWithBrowser('http://93.184.216.34/', { connect })).rejects.toBeInstanceOf(
      BrowserUnavailableError,
    );
  });
});
