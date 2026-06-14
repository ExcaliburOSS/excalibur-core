import { z } from 'zod';

/**
 * Focused zod → JSON Schema converter for native tool parameter schemas.
 *
 * The native tool catalog (`native-tools.ts`) uses a small, fixed subset of
 * zod: `z.object().strict()` with string / number(int,positive) / boolean /
 * array / optional fields and `.describe()` annotations. Rather than pull in a
 * full zod-to-json-schema dependency, this converter handles exactly that
 * subset and produces a JSON Schema `object` suitable for a {@link ToolSpec}'s
 * `parameters` (the wire shape every provider's function-calling API expects).
 *
 * It is intentionally conservative: any node it does not recognize degrades to
 * an empty (`{}`) schema rather than throwing, so an unexpected tool definition
 * still yields a valid (if permissive) spec instead of crashing the loop.
 */

type JsonSchema = Record<string, unknown>;

/** Unwraps `.optional()` / `.nullable()` / `.default()` wrappers to the inner type. */
function unwrap(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; optional: boolean } {
  let current = schema;
  let optional = false;
  // Walk the wrapper chain (optional/nullable/default all wrap an inner type).
  for (;;) {
    const def = current._def as { typeName?: string; innerType?: z.ZodTypeAny };
    if (
      def.typeName === z.ZodFirstPartyTypeKind.ZodOptional ||
      def.typeName === z.ZodFirstPartyTypeKind.ZodNullable ||
      def.typeName === z.ZodFirstPartyTypeKind.ZodDefault
    ) {
      if (def.typeName === z.ZodFirstPartyTypeKind.ZodOptional) {
        optional = true;
      }
      if (def.innerType === undefined) {
        break;
      }
      current = def.innerType;
      continue;
    }
    break;
  }
  return { inner: current, optional };
}

function description(schema: z.ZodTypeAny): string | undefined {
  const desc = (schema._def as { description?: string }).description;
  return typeof desc === 'string' && desc.length > 0 ? desc : undefined;
}

function withDescription(node: JsonSchema, schema: z.ZodTypeAny): JsonSchema {
  const desc = description(schema);
  return desc !== undefined ? { ...node, description: desc } : node;
}

/** Converts a single (already-unwrapped) zod node to a JSON Schema fragment. */
function convertNode(schema: z.ZodTypeAny): JsonSchema {
  const def = schema._def as { typeName?: string; type?: z.ZodTypeAny; checks?: unknown[] };

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString:
      return withDescription({ type: 'string' }, schema);
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const checks = (def.checks ?? []) as Array<{ kind?: string }>;
      const isInt = checks.some((check) => check.kind === 'int');
      return withDescription(isInt ? { type: 'integer' } : { type: 'number' }, schema);
    }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return withDescription({ type: 'boolean' }, schema);
    case z.ZodFirstPartyTypeKind.ZodArray: {
      const element = def.type ?? z.any();
      const { inner } = unwrap(element);
      return withDescription({ type: 'array', items: convertNode(inner) }, schema);
    }
    case z.ZodFirstPartyTypeKind.ZodObject:
      return withDescription(convertObject(schema as z.ZodObject<z.ZodRawShape>), schema);
    case z.ZodFirstPartyTypeKind.ZodEnum: {
      const values = (def as { values?: readonly string[] }).values ?? [];
      return withDescription({ type: 'string', enum: [...values] }, schema);
    }
    default:
      // Unknown node → permissive empty schema (never throws).
      return withDescription({}, schema);
  }
}

function convertObject(schema: z.ZodObject<z.ZodRawShape>): JsonSchema {
  const shape = schema.shape;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const field = value as z.ZodTypeAny;
    const { inner, optional } = unwrap(field);
    // Carry a description from the wrapper (e.g. `z.string().optional().describe()`).
    const node = convertNode(inner);
    const desc = description(field) ?? description(inner);
    properties[key] = desc !== undefined ? { ...node, description: desc } : node;
    if (!optional) {
      required.push(key);
    }
  }

  const result: JsonSchema = {
    type: 'object',
    properties,
    // `.strict()` objects forbid unknown keys; JSON Schema mirrors that.
    additionalProperties: false,
  };
  if (required.length > 0) {
    result['required'] = required;
  }
  return result;
}

/**
 * Converts a tool's zod parameter schema to a JSON Schema object. Non-object
 * top-level schemas are wrapped permissively; the native catalog always uses
 * `z.object().strict()`, so this is the normal path.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const { inner } = unwrap(schema);
  const def = inner._def as { typeName?: string };
  if (def.typeName === z.ZodFirstPartyTypeKind.ZodObject) {
    return convertObject(inner as z.ZodObject<z.ZodRawShape>);
  }
  return { type: 'object', properties: {}, additionalProperties: true };
}
