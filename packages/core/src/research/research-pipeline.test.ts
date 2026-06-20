import { describe, expect, it } from 'vitest';
import type { ChatInput, ChatOutput, ModelGateway } from '@excalibur/model-gateway';
import { runDeepResearch, type ResearchFetcher, type ResearchSearcher } from './research-pipeline';

type ChatRunner = Pick<ModelGateway, 'chat'>;

/** A gateway that routes its reply by the request's metadata.kind. */
function stagedGateway(): ChatRunner {
  return {
    chat: async (input: ChatInput): Promise<ChatOutput> => {
      const kind = String((input.metadata as { kind?: string } | undefined)?.kind ?? '');
      let content = '';
      if (kind === 'research_plan') content = 'what is mcp\nmcp introduced by';
      else if (kind === 'research_extract')
        content = 'MCP is an open protocol\nMCP was introduced by Anthropic';
      else if (kind === 'research_verify') content = 'SUPPORTED';
      else if (kind === 'research_synthesize')
        content = 'MCP is an open protocol [1] introduced by Anthropic [2].';
      return {
        content,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'fake',
        costCents: null,
        finishReason: 'stop',
      } as ChatOutput;
    },
  };
}

const search: ResearchSearcher = async (q) => [
  { url: `https://a.test/${encodeURIComponent(q)}`, title: 'A', snippet: 's' },
  { url: 'https://b.test/', title: 'B', snippet: 's' },
];
const fetch: ResearchFetcher = async (url) => ({
  markdown: `content of ${url}`,
  title: `T ${url}`,
});

describe('runDeepResearch', () => {
  it('plans → searches → fetches → verifies → synthesizes a cited report', async () => {
    const stages: string[] = [];
    const result = await runDeepResearch({
      question: 'What is MCP and who introduced it?',
      gateway: stagedGateway(),
      search,
      fetch,
      now: '2026-06-20T00:00:00.000Z',
      maxSources: 3,
      votes: 3,
      onStage: (s) => stages.push(s),
    });
    expect(stages).toEqual(
      expect.arrayContaining(['plan', 'search', 'fetch', 'extract', 'verify', 'synthesize']),
    );
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources.length).toBeLessThanOrEqual(3);
    expect(result.sources[0]?.sha256.length).toBe(64);
    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.claims.every((c) => c.verified)).toBe(true);
    expect(result.report).toContain('## Sources');
    expect(result.answer).toContain('[1]');
  });

  it('returns gracefully when no source can be fetched', async () => {
    const result = await runDeepResearch({
      question: 'Q?',
      gateway: stagedGateway(),
      search,
      fetch: async () => null,
      now: '2026-06-20T00:00:00.000Z',
    });
    expect(result.sources).toHaveLength(0);
    expect(result.answer).toContain('No sources');
  });

  it('deduplicates and caps sources at maxSources', async () => {
    const dupSearch: ResearchSearcher = async () => [
      { url: 'https://same.test/', title: 'S', snippet: '' },
      { url: 'https://same.test/', title: 'S', snippet: '' },
      { url: 'https://other.test/', title: 'O', snippet: '' },
    ];
    const result = await runDeepResearch({
      question: 'Q?',
      gateway: stagedGateway(),
      search: dupSearch,
      fetch,
      now: 't',
      maxSources: 5,
    });
    const urls = result.sources.map((s) => s.url);
    expect(new Set(urls).size).toBe(urls.length); // no duplicates
    expect(urls).toContain('https://same.test/');
  });
});
