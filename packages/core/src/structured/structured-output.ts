/**
 * Provider-agnostic structured output (plan P1.12 — `--json-schema`). Rather than
 * a provider-specific `response_format` (reasoning models like kimi-k2.7-code
 * reject extra request params), we INSTRUCT the model to emit JSON matching a
 * schema, then EXTRACT + VALIDATE client-side and re-prompt once on a mismatch.
 * Works with every provider; deterministic + dependency-free.
 *
 * The validator is a minimal JSON-Schema subset (type · properties · required ·
 * items · enum) — enough to bound CLI/CI output without pulling in ajv.
 */

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  [key: string]: unknown;
}

/** The system instruction that asks the model for schema-conforming JSON only. */
export function buildSchemaInstruction(schema: JsonSchema): string {
  return [
    'You MUST respond with ONLY a single JSON value that conforms to the JSON Schema below.',
    'Output raw JSON — no prose, no explanation, no markdown code fences.',
    '',
    'JSON Schema:',
    JSON.stringify(schema, null, 2),
  ].join('\n');
}

/** Extracts the first JSON value from model output (tolerant of fences / prose). */
export function extractJsonValue(content: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  const body = (fenced?.[1] ?? content).trim();
  // Try the whole body first (a clean JSON response), then the first {...}/[...] span.
  const candidates: string[] = [body];
  const objStart = body.indexOf('{');
  const objEnd = body.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) candidates.push(body.slice(objStart, objEnd + 1));
  const arrStart = body.indexOf('[');
  const arrEnd = body.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) candidates.push(body.slice(arrStart, arrEnd + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true; // unknown/unsupported type keyword → don't reject
  }
}

/**
 * Validates a value against the supported JSON-Schema subset. Returns a list of
 * human-readable errors (empty = valid). Best-effort: unsupported keywords are
 * ignored rather than failing.
 */
export function validateAgainstSchema(value: unknown, schema: JsonSchema, path = '$'): string[] {
  const errors: string[] = [];
  if (typeof schema.type === 'string' && !matchesType(value, schema.type)) {
    errors.push(`${path}: expected ${schema.type}`);
    return errors; // type mismatch — deeper checks are meaningless
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) {
    errors.push(`${path}: value is not one of the allowed enum values`);
  }
  if (schema.type === 'object' && typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) errors.push(`${path}.${req}: required property is missing`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) errors.push(...validateAgainstSchema(obj[key], sub, `${path}.${key}`));
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, i) => {
      errors.push(...validateAgainstSchema(item, schema.items as JsonSchema, `${path}[${i}]`));
    });
  }
  return errors;
}

export interface StructuredChatRunner {
  chat(input: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    provider?: string;
    maxTokens?: number;
    metadata?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<{ content: string }>;
}

export interface StructuredAskInput {
  question: string;
  schema: JsonSchema;
  /** Extra system context (effective instructions / repo retrieval). */
  systemContext?: string;
  provider?: string;
  signal?: AbortSignal;
}

export interface StructuredAskResult {
  value: unknown;
  /** Validation errors against the schema (empty when the value conforms). */
  errors: string[];
  /** True when a second (corrective) attempt was needed. */
  retried: boolean;
  /** The raw model text of the final attempt (for debugging / persistence). */
  raw: string;
}

/**
 * Asks the model for a schema-conforming JSON answer: one attempt, and if it
 * does not parse/validate, ONE corrective re-prompt that feeds back the exact
 * errors. Returns the parsed value + any residual validation errors (the caller
 * decides whether to fail on them).
 */
export async function askStructured(
  gateway: StructuredChatRunner,
  input: StructuredAskInput,
): Promise<StructuredAskResult> {
  const system = [input.systemContext, buildSchemaInstruction(input.schema)]
    .filter((s): s is string => s !== undefined && s.length > 0)
    .join('\n\n');
  const providerOpt = input.provider !== undefined ? { provider: input.provider } : {};
  const signalOpt = input.signal !== undefined ? { signal: input.signal } : {};

  const attempt = async (
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  ): Promise<{ value: unknown; errors: string[]; raw: string }> => {
    const out = await gateway.chat({
      messages,
      maxTokens: 1500,
      ...providerOpt,
      ...signalOpt,
      metadata: { kind: 'ask-structured' },
    });
    const value = extractJsonValue(out.content);
    const errors =
      value === undefined
        ? ['response was not valid JSON']
        : validateAgainstSchema(value, input.schema);
    return { value, errors, raw: out.content };
  };

  const first = await attempt([
    { role: 'system', content: system },
    { role: 'user', content: input.question },
  ]);
  if (first.errors.length === 0) {
    return { value: first.value, errors: [], retried: false, raw: first.raw };
  }

  // One corrective pass: show the model its output + the precise errors.
  const second = await attempt([
    { role: 'system', content: system },
    { role: 'user', content: input.question },
    { role: 'assistant', content: first.raw },
    {
      role: 'user',
      content: `Your previous response did not conform to the schema:\n- ${first.errors.join('\n- ')}\n\nReply again with ONLY corrected JSON.`,
    },
  ]);
  return { value: second.value, errors: second.errors, retried: true, raw: second.raw };
}
