import { createHash } from 'node:crypto';
import { estimateTokens } from '../cost/cost';
import type {
  ChatDelta,
  ChatInput,
  ChatMessage,
  ChatOutput,
  ModelProviderAdapter,
} from '../types';

/**
 * Deterministic mock provider (Build Contract §7).
 *
 * Output is a pure function of the input messages: `sha256(JSON.stringify(messages))`
 * selects stable phrasing variants and derives a fake latency of 30–80 ms.
 * The response template is selected by `metadata.kind`. Every template starts
 * with a `> Mock provider (M1)` quote line so the output can never be
 * mistaken for a real model answer.
 */

export const MOCK_RESPONSE_KINDS = [
  'review',
  'explain',
  'ask',
  'plan',
  'patch',
  'summary',
  'alternatives',
  'test_generation',
] as const;
export type MockResponseKind = (typeof MOCK_RESPONSE_KINDS)[number];

const MOCK_BANNER = '> Mock provider (M1) — deterministic local output; no real model was called.';
const DEFAULT_MOCK_MODEL = 'mock-model';
const DEFAULT_PATCH_TARGET = 'src/example.service.ts';
const EXCERPT_MAX_LENGTH = 200;
const MAX_PATCH_TARGETS = 3;

/** Contract-pinned path detection (with a trailing boundary so `.tsx` is not cut to `.ts`). */
const FILE_PATH_PATTERN = /[\w./-]+\.(?:ts|js|tsx|py|go|rb|java)\b/g;

function hashMessages(messages: ChatMessage[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}

/** Fake latency 30–80 ms, derived from the message hash (deterministic). */
function latencyMsFromHash(hash: string): number {
  return 30 + (Number.parseInt(hash.slice(0, 2), 16) % 51);
}

function variantIndexFromHash(hash: string): number {
  return Number.parseInt(hash.slice(2, 4), 16);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMockResponseKind(value: unknown): value is MockResponseKind {
  return (
    typeof value === 'string' && (MOCK_RESPONSE_KINDS as readonly string[]).includes(value)
  );
}

function resolveKind(metadata: Record<string, unknown> | undefined): MockResponseKind {
  const kind = metadata?.['kind'];
  return isMockResponseKind(kind) ? kind : 'ask';
}

function lastUserContent(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.role === 'user') {
      return message.content;
    }
  }
  const last = messages[messages.length - 1];
  return last?.content ?? '';
}

/** Single-line, truncated quote of the user content. */
function excerptOf(messages: ChatMessage[]): string {
  const content = lastUserContent(messages).replace(/\s+/g, ' ').trim();
  if (content.length === 0) {
    return '(empty prompt)';
  }
  return content.length > EXCERPT_MAX_LENGTH
    ? `${content.slice(0, EXCERPT_MAX_LENGTH)}…`
    : content;
}

function detectFilePaths(messages: ChatMessage[]): string[] {
  const haystack = messages.map((message) => message.content).join('\n');
  const matches = haystack.match(FILE_PATH_PATTERN) ?? [];
  const unique: string[] = [];
  for (const match of matches) {
    const normalized = match.replace(/^\.\/+/, '').replace(/^\/+/, '');
    if (normalized.length > 0 && !unique.includes(normalized)) {
      unique.push(normalized);
    }
  }
  return unique.slice(0, MAX_PATCH_TARGETS);
}

function classNameFromPath(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  const stem = base.replace(/\.[^.]+$/, '');
  const parts = stem.split(/[^A-Za-z0-9]+/).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return 'ExampleService';
  }
  return parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Builds a syntactically valid, APPLIABLE unified diff that CREATES each
 * task-derived path as a new file (`--- /dev/null` → `+++ b/<path>`), with a
 * plausible idempotency guard-clause helper (5 added lines per file, within
 * the contract's 3–10 changed-line window).
 *
 * A new-file diff applies cleanly with `git apply` against any repository
 * where the path does not yet exist — including the empty/temp repos used by
 * the offline propose→validate→apply/branch tests — so the mock provider can
 * demonstrate the full loop zero-config with no real model.
 */
function buildUnifiedDiff(paths: string[]): string {
  const targets = paths.length > 0 ? paths : [DEFAULT_PATCH_TARGET];
  const sections = targets.map((filePath) => {
    const className = classNameFromPath(filePath);
    const body = [
      `export class ${className} {`,
      '  // Idempotency guard: a repeated release request must be a no-op.',
      "  released(status: string): boolean {",
      "    return status === 'released';",
      '  }',
    ];
    return [
      '--- /dev/null',
      `+++ b/${filePath}`,
      `@@ -0,0 +1,${body.length} @@`,
      ...body.map((line) => `+${line}`),
    ].join('\n');
  });
  return sections.join('\n');
}

interface RenderContext {
  excerpt: string;
  variant: number;
  paths: string[];
}

function pick(variant: number, phrases: readonly string[]): string {
  return phrases[variant % phrases.length] ?? phrases[0] ?? '';
}

const TEMPLATES: Record<MockResponseKind, (ctx: RenderContext) => string> = {
  review: ({ excerpt, variant }) =>
    [
      MOCK_BANNER,
      '',
      '## Code review',
      '',
      'Reviewing:',
      '',
      `> ${excerpt}`,
      '',
      pick(variant, [
        'Overall the change is sound; two findings are worth addressing before merge.',
        'The implementation works, but there are a couple of robustness gaps to close.',
        'Solid direction. I flagged one correctness risk and one style nit.',
      ]),
      '',
      '- **[medium] Missing guard clause** — the operation is not idempotent; a repeated call would run the mutation twice.',
      '- **[low] Error handling** — failures are swallowed instead of being surfaced as typed errors.',
      '',
      'No blocking issues beyond the guard clause.',
    ].join('\n'),

  explain: ({ excerpt, variant }) =>
    [
      MOCK_BANNER,
      '',
      '## Explanation',
      '',
      'You asked about:',
      '',
      `> ${excerpt}`,
      '',
      pick(variant, [
        'This code follows a service/repository split: the service owns business rules, the repository owns persistence.',
        'The flow is straightforward: load the record, apply the state transition, persist the result.',
        'At its core this is a state-transition routine guarded by repository lookups.',
      ]),
      '',
      '1. The entry point validates its input and loads the affected record.',
      '2. The business rule is applied as an in-memory state change.',
      '3. The result is persisted and downstream consumers are notified.',
    ].join('\n'),

  ask: ({ excerpt, variant }) =>
    [
      MOCK_BANNER,
      '',
      '## Answer',
      '',
      'You asked:',
      '',
      `> ${excerpt}`,
      '',
      pick(variant, [
        'Short answer: yes, with one caveat around idempotency.',
        'The relevant logic lives in the service layer; here is what matters.',
        'Based on the repository context, the behavior you are seeing is expected.',
      ]),
      '',
      '- The code paths involved are small and well-contained.',
      '- The main risk area is repeated execution of non-idempotent operations.',
      '- A focused patch (guard clause + test) is the lowest-risk next step.',
    ].join('\n'),

  plan: ({ excerpt, variant }) =>
    [
      MOCK_BANNER,
      '',
      '## Plan',
      '',
      'Task:',
      '',
      `> ${excerpt}`,
      '',
      pick(variant, [
        'A three-phase plan keeps the change reviewable and reversible.',
        'The safest sequencing is: reproduce, fix behind a guard, verify.',
        'This breaks down into small, independently verifiable steps.',
      ]),
      '',
      '1. **Reproduce** — add a failing test that captures the current behavior.',
      '2. **Implement** — apply the minimal fix (guard clause / state check).',
      '3. **Verify** — run the test suite and lint; confirm no regressions.',
      '4. **Document** — summarize the change for review.',
    ].join('\n'),

  patch: ({ excerpt, variant, paths }) =>
    [
      MOCK_BANNER,
      '',
      '## Proposed patch',
      '',
      'Task:',
      '',
      `> ${excerpt}`,
      '',
      pick(variant, [
        'The patch adds an idempotency guard so a repeated request becomes a no-op.',
        'A small guard clause prevents the duplicate state transition.',
        'The minimal fix: check the current status before mutating state.',
      ]),
      '',
      'Files affected:',
      '',
      ...(paths.length > 0 ? paths : [DEFAULT_PATCH_TARGET]).map((path) => `- \`${path}\``),
      '',
      '```diff',
      buildUnifiedDiff(paths),
      '```',
      '',
      'The guard returns early when the record is already in its target state, making the operation safe to retry.',
    ].join('\n'),

  summary: ({ excerpt, variant }) =>
    [
      MOCK_BANNER,
      '',
      '## Summary',
      '',
      'Input:',
      '',
      `> ${excerpt}`,
      '',
      pick(variant, [
        'Key points, condensed:',
        'The essentials:',
        'In short:',
      ]),
      '',
      '- The scope is clear and small enough for a single iteration.',
      '- The main risk is a non-idempotent state transition.',
      '- Recommended next step: a guarded fix with a regression test.',
    ].join('\n'),

  alternatives: ({ excerpt, variant }) =>
    [
      MOCK_BANNER,
      '',
      '## Alternatives',
      '',
      'For:',
      '',
      `> ${excerpt}`,
      '',
      pick(variant, [
        'Three viable approaches, ordered by implementation effort:',
        'There are three reasonable ways to tackle this:',
        'Trade-offs across the candidate approaches:',
      ]),
      '',
      '### Option A — Guard clause (recommended)',
      'Minimal diff, no schema changes, safe to retry. Low risk.',
      '',
      '### Option B — Database constraint',
      'Strongest guarantee, but requires a migration and deploy coordination. Medium risk.',
      '',
      '### Option C — Distributed lock',
      'Handles concurrent callers, adds infrastructure and failure modes. High effort.',
    ].join('\n'),

  test_generation: ({ excerpt, variant }) =>
    [
      MOCK_BANNER,
      '',
      '## Generated tests',
      '',
      'Target:',
      '',
      `> ${excerpt}`,
      '',
      pick(variant, [
        'These tests pin the idempotency contract of the operation.',
        'Coverage focuses on the duplicate-invocation path.',
        'The suite below exercises the happy path and the retry path.',
      ]),
      '',
      '```ts',
      "describe('release', () => {",
      "  it('releases a pending record', async () => {",
      "    const record = await service.release('rec_1');",
      "    expect(record.status).toBe('released');",
      '  });',
      '',
      "  it('is a no-op when the record is already released', async () => {",
      "    await service.release('rec_1');",
      "    await expect(service.release('rec_1')).resolves.not.toThrow();",
      '    expect(repository.saveCalls).toBe(1);',
      '  });',
      '});',
      '```',
    ].join('\n'),
};

function renderMockContent(input: ChatInput, hash: string): string {
  const kind = resolveKind(input.metadata);
  return TEMPLATES[kind]({
    excerpt: excerptOf(input.messages),
    variant: variantIndexFromHash(hash),
    paths: detectFilePaths(input.messages),
  });
}

export interface MockProviderOptions {
  /** Adapter name as configured in providers.yaml (defaults to `mock`). */
  name?: string;
  /** Model name reported when the input does not specify one. */
  model?: string;
  /** Disable the fake 30–80 ms latency (useful in tests). Defaults to true. */
  simulateLatency?: boolean;
}

export class MockProvider implements ModelProviderAdapter {
  readonly name: string;
  private readonly defaultModel: string;
  private readonly simulateLatency: boolean;

  constructor(options?: MockProviderOptions) {
    this.name = options?.name ?? 'mock';
    this.defaultModel = options?.model ?? DEFAULT_MOCK_MODEL;
    this.simulateLatency = options?.simulateLatency ?? true;
  }

  async chat(input: ChatInput): Promise<ChatOutput> {
    const hash = hashMessages(input.messages);
    if (this.simulateLatency) {
      await sleep(latencyMsFromHash(hash));
    }
    const content = renderMockContent(input, hash);
    return {
      content,
      model: input.model ?? this.defaultModel,
      usage: {
        inputTokens: estimateTokens(
          input.messages.map((message) => message.content).join('\n'),
        ),
        outputTokens: estimateTokens(content),
      },
      costCents: null,
      finishReason: 'stop',
    };
  }

  async *stream(input: ChatInput): AsyncIterable<ChatDelta> {
    const hash = hashMessages(input.messages);
    if (this.simulateLatency) {
      await sleep(latencyMsFromHash(hash));
    }
    const content = renderMockContent(input, hash);
    // Split keeping the newline with each chunk so concatenation === chat().content.
    for (const chunk of content.split(/(?<=\n)/)) {
      yield { content: chunk, done: false };
    }
    yield { content: '', done: true };
  }
}
