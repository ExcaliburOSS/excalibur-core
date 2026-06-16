import {
  redactSecrets,
  type ChatMessage,
  type ChatOutput,
  type GatewayChatInput,
} from '@excalibur/model-gateway';
import type { StructuredSummary, TranscriptEntry } from './types';

/**
 * Real-model compaction summarizer (M2) — the production counterpart to the
 * deterministic `defaultSummarizer`. It implements the same
 * `(entries) => {summary, structuredSummary}` contract, but ASYNCHRONOUSLY: it
 * routes a single chat call to a model (typically the FAST `cheap` role, low
 * cost + latency) to condense the older prefix of a long session into a
 * structured summary, so the conversation stays within the context window
 * without losing the thread (plan §"Compactación de contexto" → M2).
 *
 * Robustness, in layers:
 *  - Every entry is redacted and per-entry/total length-capped before it ever
 *    reaches the model (secrets never leave; the cheap model is never flooded).
 *  - The model is asked for a strict JSON object; the parse is defensive
 *    (tolerates code fences / prose around it). On a parse miss with non-empty
 *    content, it degrades to a prose-only summary rather than failing.
 *  - The `condensed` counts are ALWAYS computed deterministically from the
 *    entries — never trusted to the model.
 *  - All summary text + structured fields are redacted again on the way out.
 *  - On a hard failure (no content / the call throws) it THROWS, so the caller
 *    falls back to the offline `defaultSummarizer` — compaction still happens.
 */

/** The minimal chat surface the summarizer needs; `ModelGateway` satisfies it. */
export interface SummarizerChat {
  chat(input: GatewayChatInput): Promise<ChatOutput>;
}

/** An async `(entries) => {summary, structuredSummary}` (model-backed) summarizer. */
export type AsyncSummarizer = (
  entries: ReadonlyArray<TranscriptEntry>,
) => Promise<{ summary: string; structuredSummary: StructuredSummary }>;

export interface ModelSummarizerOptions {
  /** The chat surface (e.g. the gateway). */
  chat: SummarizerChat;
  /** Provider to route to — typically the `cheap` role. Omitted → gateway default. */
  provider?: string;
  /** Locale for the prose summary/objective (`es` → Spanish; anything else → English). */
  locale?: string;
  /** Per-call timeout (ms); summarization should be quick on the cheap model. */
  timeoutMs?: number;
  /** Abort signal forwarded to the chat call. */
  signal?: AbortSignal;
}

/** Per-entry and total input caps — bound the cheap model's input cost. */
const MAX_ENTRY_CHARS = 1500;
const MAX_INPUT_CHARS = 12_000;
// Generous enough that the structured JSON completes (a truncated object fails to
// parse and degrades to prose); the input caps keep total cost bounded anyway.
const MAX_OUTPUT_TOKENS = 1500;
const DEFAULT_TIMEOUT_MS = 25_000;

/** Renders the entries into a redacted, length-capped, role-tagged transcript. */
function renderEntries(entries: ReadonlyArray<TranscriptEntry>): string {
  const lines = entries.map(
    (e) => `[${e.role}] ${redactSecrets(e.text).replace(/\s+/g, ' ').trim().slice(0, MAX_ENTRY_CHARS)}`,
  );
  const joined = lines.join('\n\n');
  return joined.length > MAX_INPUT_CHARS
    ? `${joined.slice(0, MAX_INPUT_CHARS)}\n…[older detail elided; full history stays in the run event stream]`
    : joined;
}

/** Deterministic condensed counts — never trusted to the model. */
function condensedOf(entries: ReadonlyArray<TranscriptEntry>): StructuredSummary['condensed'] {
  return {
    entries: entries.length,
    userTurns: entries.filter((e) => e.role === 'user').length,
    assistantTurns: entries.filter((e) => e.role === 'assistant').length,
  };
}

/** Extracts and parses the first balanced JSON object from model output (fence-tolerant). */
function parseJsonObject(content: string): Record<string, unknown> | null {
  const match = content.match(/\{[\s\S]*\}/);
  if (match === null) {
    return null;
  }
  try {
    const value = JSON.parse(match[0]) as unknown;
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Salvages the prose `summary` from output that did NOT fully parse (e.g. JSON
 * truncated at the token limit, so it has no closing brace). Returns the decoded
 * string value of the first `"summary": "…"` field, or null if absent.
 */
function salvageSummaryField(content: string): string | null {
  const m = content.match(/"summary"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (m === null) {
    return null;
  }
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1] ?? null;
  }
}

/** Coerces an unknown JSON field to a clean, redacted string array (caps length + count). */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => redactSecrets(item.trim()).slice(0, 300))
    .filter((item) => item.length > 0)
    .slice(0, 20);
}

/** Coerces an unknown JSON field to a clean, redacted string. */
function toStringField(value: unknown, max: number): string {
  return typeof value === 'string' ? redactSecrets(value.replace(/\s+/g, ' ').trim()).slice(0, max) : '';
}

/**
 * Builds an async, model-backed summarizer. The returned function is a drop-in
 * for the compactor's `summarize` strategy (its async sibling `compactAsync`).
 */
export function createModelSummarizer(options: ModelSummarizerOptions): AsyncSummarizer {
  const spanish = (options.locale ?? 'en').toLowerCase().startsWith('es');
  const languageRule = spanish
    ? 'Write `summary`, `objective`, `decisions` and `pending` in Spanish.'
    : 'Write `summary`, `objective`, `decisions` and `pending` in English.';

  const system =
    'You compress the EARLIER part of a coding-agent conversation into a faithful, compact summary so ' +
    'the session stays within the context window. Preserve the objective, decisions made (and why), ' +
    'files touched, and what is still pending. Do NOT invent anything. Respond with ONLY a single JSON ' +
    'object, no prose around it, with exactly these keys: ' +
    '{"summary": string (≤ 6 sentences of prose), "objective": string, "decisions": string[], ' +
    '"filesTouched": string[], "pending": string[]}. ' +
    languageRule;

  return async (entries) => {
    const condensed = condensedOf(entries);
    const output = await options.chat.chat({
      messages: [
        { role: 'system', content: system } satisfies ChatMessage,
        { role: 'user', content: renderEntries(entries) } satisfies ChatMessage,
      ],
      maxTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      metadata: { kind: 'compact' },
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });

    const content = output.content.trim();
    if (content.length === 0) {
      // Hard failure — let the caller fall back to the offline default.
      throw new Error('Model summarizer returned empty content.');
    }

    const parsed = parseJsonObject(content);
    if (parsed === null) {
      // Graceful degradation: the JSON did not parse (e.g. truncated). Salvage
      // the prose `summary` field if present; otherwise use the raw text. Either
      // way, redact and pair with a deterministic structured skeleton.
      const salvaged = salvageSummaryField(content) ?? content;
      return {
        summary: redactSecrets(salvaged).slice(0, 2000),
        structuredSummary: { objective: '', decisions: [], filesTouched: [], pending: [], condensed },
      };
    }

    const summary = toStringField(parsed['summary'], 2000);
    return {
      summary: summary.length > 0 ? summary : redactSecrets(content).slice(0, 2000),
      structuredSummary: {
        objective: toStringField(parsed['objective'], 400),
        decisions: toStringArray(parsed['decisions']),
        filesTouched: toStringArray(parsed['filesTouched']),
        pending: toStringArray(parsed['pending']),
        condensed,
      },
    };
  };
}
