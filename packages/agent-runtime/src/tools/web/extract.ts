import type { ModelGateway } from '@excalibur/model-gateway';

/**
 * `web_extract` core (F4): turn a fetched page into caller-specified STRUCTURED
 * data. The browser-enabled path passes rendered markdown; the keyless path
 * passes the free Tier-1 markdown. Either way it runs ONE constrained model call
 * — "return ONLY JSON matching this schema" — through the gateway threaded onto
 * the tool-execution context, then parses the result. The gateway is INJECTED so
 * this is unit-tested with a fake chat runner (offline, no real model).
 */

/** The narrow gateway dependency: just `chat`. */
export type GatewayChat = Pick<ModelGateway, 'chat'>;

export class ExtractError extends Error {}

export interface ExtractOptions {
  /** JSON-Schema object describing the fields to extract. */
  schema: Record<string, unknown>;
  /** The page content the model extracts from (Tier-1 or browser markdown). */
  markdown: string;
  gateway: GatewayChat;
  model?: string;
  provider?: string;
  /** Extra natural-language guidance for ambiguous fields. */
  instructions?: string;
  signal?: AbortSignal;
  /** Which tier produced `markdown` (recorded in the result). */
  source?: 'browser' | 'tier1';
  /** Cap on page characters fed to the model (default 24000). */
  maxInputChars?: number;
}

export interface ExtractResult {
  data: unknown;
  source: 'browser' | 'tier1';
  truncated: boolean;
}

const DEFAULT_MAX_INPUT_CHARS = 24_000;

const SYSTEM_PROMPT =
  'You extract structured data from web page content. Return ONLY a single JSON value that conforms to the provided JSON Schema — no prose, no explanation, no markdown code fences. If a field is absent on the page, use null (or omit it if the schema allows). Output must be parseable by JSON.parse.';

/** Best-effort JSON extraction from a model reply (strips fences / surrounding prose). */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    // Fall back to the first balanced {...} or [...] span.
    const firstObj = unfenced.indexOf('{');
    const firstArr = unfenced.indexOf('[');
    const start =
      firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
    if (start === -1) {
      throw new ExtractError('Model did not return JSON.');
    }
    const open = unfenced[start];
    const close = open === '{' ? '}' : ']';
    const end = unfenced.lastIndexOf(close);
    if (end <= start) {
      throw new ExtractError('Model returned unbalanced JSON.');
    }
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      throw new ExtractError('Model returned invalid JSON.');
    }
  }
}

/** Extracts structured data matching `schema` from a page's markdown via one model call. */
export async function extractStructured(url: string, opts: ExtractOptions): Promise<ExtractResult> {
  const maxInput = opts.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
  const truncated = opts.markdown.length > maxInput;
  const page = truncated ? opts.markdown.slice(0, maxInput) : opts.markdown;
  const guidance =
    opts.instructions !== undefined && opts.instructions.length > 0
      ? `Guidance: ${opts.instructions}\n\n`
      : '';
  const user = `JSON Schema:\n${JSON.stringify(opts.schema)}\n\n${guidance}Page content (${url}):\n\n${page}`;

  const output = await opts.gateway.chat({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
    metadata: { kind: 'extract', tool: 'web_extract' },
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  return { data: parseJsonLoose(output.content), source: opts.source ?? 'tier1', truncated };
}
