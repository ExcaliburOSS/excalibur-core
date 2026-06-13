import { describe, expect, it } from 'vitest';
import { policyDecisionSchema, DEFAULT_CONFIG } from '@excalibur/shared';
import { createNoopLogger } from '../logger';
import type {
  CommunicationProvider,
  PostMessageInput,
  PostMessageResult,
  PostThreadReplyInput,
  ThreadReply,
} from './communication';
import type { AgentTool, ToolResult } from './tools';
import type { ContextDocument, ContextSource } from './context-source';
import { policyDecisionResultSchema } from './policy';
import type { PolicyContext, PolicyDecision, PolicyEvaluator } from './policy';
import type { ReportGenerator, ReportOutput } from './reports';
import type { Exporter, ExportResult } from './exporters';

/**
 * Small fake implementations of every contribution interface owned by the
 * SDK, proving the shapes are implementable and behave as documented.
 */

class FakeChatProvider implements CommunicationProvider {
  readonly type = 'fake-chat';
  private readonly threads = new Map<string, ThreadReply[]>();
  private sequence = 0;

  async postMessage(input: PostMessageInput): Promise<PostMessageResult> {
    const id = `msg-${++this.sequence}`;
    this.threads.set(id, []);
    return {
      externalMessageId: id,
      threadId: id,
      url: `https://chat.example.com/${input.channelId}/${id}`,
    };
  }

  async postThreadReply(input: PostThreadReplyInput): Promise<PostMessageResult> {
    const replies = this.threads.get(input.threadId);
    if (replies === undefined) {
      throw new Error(`unknown thread ${input.threadId}`);
    }
    const id = `msg-${++this.sequence}`;
    replies.push({ externalMessageId: id, body: input.markdown, authorName: 'excalibur' });
    return { externalMessageId: id, threadId: input.threadId };
  }

  async getThreadReplies(input: { channelId: string; threadId: string }): Promise<ThreadReply[]> {
    return this.threads.get(input.threadId) ?? [];
  }

  async validateCredentials(): Promise<boolean> {
    return true;
  }
}

describe('CommunicationProvider', () => {
  it('posts messages, threads replies and reads them back', async () => {
    const provider = new FakeChatProvider();

    const message = await provider.postMessage({ channelId: 'C1', markdown: 'Run completed' });
    expect(message.externalMessageId).toBe('msg-1');
    expect(message.threadId).toBe('msg-1');
    expect(message.url).toContain('/C1/');

    await provider.postThreadReply({
      channelId: 'C1',
      threadId: message.threadId as string,
      markdown: 'Artifacts attached',
    });

    const replies = await provider.getThreadReplies({
      channelId: 'C1',
      threadId: message.threadId as string,
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]?.body).toBe('Artifacts attached');
    await expect(provider.validateCredentials()).resolves.toBe(true);
  });
});

describe('AgentTool', () => {
  it('executes with a ToolContext and returns a ToolResult', async () => {
    const tool: AgentTool = {
      name: 'count-chars',
      description: 'Counts the characters of input.text.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      async execute(input, context): Promise<ToolResult> {
        const text = (input as { text?: unknown }).text;
        if (typeof text !== 'string') {
          return { success: false, output: '', error: 'input.text must be a string' };
        }
        context.logger.info(`counting ${text.length} chars`);
        return { success: true, output: String(text.length), data: { length: text.length } };
      },
    };

    const ok = await tool.execute(
      { text: 'excalibur' },
      { workdir: '/tmp/repo', config: DEFAULT_CONFIG, logger: createNoopLogger() },
    );
    expect(ok).toEqual({ success: true, output: '9', data: { length: 9 } });

    const failed = await tool.execute(
      { text: 42 },
      { workdir: '/tmp/repo', config: DEFAULT_CONFIG, logger: createNoopLogger() },
    );
    expect(failed.success).toBe(false);
    expect(failed.error).toContain('input.text');
  });
});

describe('ContextSource', () => {
  const documents: ContextDocument[] = [
    { id: 'doc-1', title: 'Escrow design', content: 'Escrow release must be idempotent.' },
    { id: 'doc-2', title: 'Payments runbook', content: 'On payout failure, retry once.' },
  ];
  const source: ContextSource = {
    id: 'fake-wiki',
    name: 'Fake Wiki',
    async search(input) {
      const matches = documents.filter((doc) =>
        `${doc.title} ${doc.content}`.toLowerCase().includes(input.query.toLowerCase()),
      );
      return matches.slice(0, input.limit ?? matches.length).map((doc, index) => ({
        ...doc,
        sourceId: 'fake-wiki',
        score: 1 - index * 0.1,
      }));
    },
    async load(input) {
      const doc = documents.find((candidate) => candidate.id === input.documentId);
      if (doc === undefined) {
        throw new Error(`unknown document ${input.documentId}`);
      }
      return doc;
    },
  };

  it('searches with a limit and scores results', async () => {
    const results = await source.search({ query: 'escrow', limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('doc-1');
    expect(results[0]?.sourceId).toBe('fake-wiki');
  });

  it('loads a document by id', async () => {
    const doc = await source.load({ documentId: 'doc-2' });
    expect(doc.title).toBe('Payments runbook');
  });
});

describe('PolicyEvaluator', () => {
  const evaluator: PolicyEvaluator = {
    id: 'sensitive-paths',
    async evaluate(context: PolicyContext): Promise<PolicyDecision> {
      if (context.filePath !== undefined && context.filePath.includes('billing/')) {
        return { decision: 'require_approval', reason: 'billing paths need human review' };
      }
      if (context.command !== undefined && context.command.startsWith('rm ')) {
        return { decision: 'deny', reason: 'destructive command' };
      }
      return { decision: 'allow' };
    },
  };

  it('returns decisions whose value conforms to the shared policyDecisionSchema', async () => {
    const contexts: PolicyContext[] = [
      { action: 'file_write', filePath: 'src/billing/invoice.ts', autonomyLevel: 3 },
      { action: 'command_run', command: 'rm -rf /' },
      { action: 'file_read', filePath: 'README.md' },
    ];
    const decisions = await Promise.all(contexts.map((ctx) => evaluator.evaluate(ctx)));

    expect(decisions.map((d) => d.decision)).toEqual(['require_approval', 'deny', 'allow']);
    for (const decision of decisions) {
      expect(policyDecisionSchema.safeParse(decision.decision).success).toBe(true);
      expect(policyDecisionResultSchema.safeParse(decision).success).toBe(true);
    }
  });
});

describe('ReportGenerator', () => {
  it('generates a markdown report from host-provided data', async () => {
    const generator: ReportGenerator = {
      id: 'daily-runs',
      async generate(input): Promise<ReportOutput> {
        const runs = (input.data?.['runs'] as string[] | undefined) ?? [];
        return {
          title: `Daily summary (${input.date ?? 'today'})`,
          markdown: `# Daily summary\n\n${runs.map((r) => `- ${r}`).join('\n')}`,
          fileName: `daily-${input.date ?? 'today'}.md`,
        };
      },
    };

    const report = await generator.generate({
      repoRoot: '/tmp/repo',
      date: '2026-06-13',
      data: { runs: ['run_20260613_101500 completed'] },
    });
    expect(report.title).toBe('Daily summary (2026-06-13)');
    expect(report.markdown).toContain('run_20260613_101500');
    expect(report.fileName).toBe('daily-2026-06-13.md');
  });
});

describe('Exporter', () => {
  it('exports selected artifacts and reports warnings', async () => {
    const exporter: Exporter = {
      id: 'archive',
      async export(input): Promise<ExportResult> {
        const ids = input.ids ?? [];
        return {
          success: true,
          exportedCount: ids.length,
          destination: input.destination ?? 's3://default-bucket',
          warnings: ids.length === 0 ? ['nothing to export'] : [],
        };
      },
    };

    const empty = await exporter.export({ repoRoot: '/tmp/repo', kind: 'runs' });
    expect(empty).toMatchObject({ success: true, exportedCount: 0 });
    expect(empty.warnings).toEqual(['nothing to export']);

    const result = await exporter.export({
      repoRoot: '/tmp/repo',
      kind: 'runs',
      ids: ['run_20260613_101500'],
      destination: 's3://acme-archive',
    });
    expect(result).toEqual({
      success: true,
      exportedCount: 1,
      destination: 's3://acme-archive',
      warnings: [],
    });
  });
});
