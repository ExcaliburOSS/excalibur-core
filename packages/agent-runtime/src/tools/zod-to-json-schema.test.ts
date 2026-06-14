import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NATIVE_TOOLS } from './native-tools';
import { zodToJsonSchema } from './zod-to-json-schema';

describe('zodToJsonSchema', () => {
  it('converts a strict object with required and optional fields', () => {
    const schema = z
      .object({
        name: z.string().describe('the name'),
        count: z.number().int().positive().optional().describe('how many'),
        flag: z.boolean().optional(),
      })
      .strict();
    const json = zodToJsonSchema(schema);
    expect(json).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'the name' },
        count: { type: 'integer', description: 'how many' },
        flag: { type: 'boolean' },
      },
      required: ['name'],
    });
  });

  it('handles arrays of strings', () => {
    const schema = z.object({ paths: z.array(z.string()).optional() }).strict();
    const json = zodToJsonSchema(schema) as {
      properties: { paths: { type: string; items: { type: string } } };
      required?: string[];
    };
    expect(json.properties.paths).toEqual({ type: 'array', items: { type: 'string' } });
    expect(json.required).toBeUndefined();
  });

  it('produces a valid JSON Schema object for every native tool', () => {
    for (const tool of NATIVE_TOOLS) {
      const json = zodToJsonSchema(tool.parameters) as Record<string, unknown>;
      expect(json['type']).toBe('object');
      expect(typeof json['properties']).toBe('object');
      expect(json['additionalProperties']).toBe(false);
    }
  });

  it('marks read_file.path required and list_files.path optional', () => {
    const read = zodToJsonSchema(NATIVE_TOOLS.find((t) => t.name === 'read_file')!.parameters) as {
      required?: string[];
    };
    expect(read.required).toEqual(['path']);
    const list = zodToJsonSchema(NATIVE_TOOLS.find((t) => t.name === 'list_files')!.parameters) as {
      required?: string[];
    };
    expect(list.required).toBeUndefined();
  });
});
