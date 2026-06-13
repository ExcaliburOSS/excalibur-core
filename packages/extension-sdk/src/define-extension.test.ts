import { describe, expect, it } from 'vitest';
import { ExcaliburError } from '@excalibur/shared';
import { ExtensionDefinitionError } from './errors';
import {
  defineExtension,
  isExcaliburExtension,
  registerExtension,
  type ExtensionDefinition,
} from './define-extension';

function validDefinition(): ExtensionDefinition {
  return {
    id: 'linear',
    name: 'Linear',
    version: '0.1.0',
    description: 'Linear work item provider for Excalibur.',
    register: () => undefined,
  };
}

describe('defineExtension', () => {
  it('returns a frozen extension preserving id, name, version, description and register', () => {
    const def = validDefinition();
    const ext = defineExtension(def);

    expect(ext.id).toBe('linear');
    expect(ext.name).toBe('Linear');
    expect(ext.version).toBe('0.1.0');
    expect(ext.description).toBe('Linear work item provider for Excalibur.');
    expect(ext.register).toBe(def.register);
    expect(Object.isFrozen(ext)).toBe(true);
  });

  it('omits description when not provided', () => {
    const { description: _description, ...rest } = validDefinition();
    const ext = defineExtension(rest);
    expect('description' in ext).toBe(false);
  });

  it.each<[string, ExtensionDefinition]>([
    ['empty id', { ...validDefinition(), id: '' }],
    ['blank id', { ...validDefinition(), id: '   ' }],
    ['whitespace in id', { ...validDefinition(), id: 'my extension' }],
    ['empty name', { ...validDefinition(), name: '' }],
    ['empty version', { ...validDefinition(), version: '' }],
  ])('throws ExtensionDefinitionError for %s', (_label, def) => {
    expect(() => defineExtension(def)).toThrow(ExtensionDefinitionError);
  });

  it('throws when register is not a function', () => {
    const def = { ...validDefinition(), register: 'not-a-function' };
    expect(() => defineExtension(def as unknown as ExtensionDefinition)).toThrow(
      ExtensionDefinitionError,
    );
  });

  it('throws when description is present but not a string', () => {
    const def = { ...validDefinition(), description: 42 };
    expect(() => defineExtension(def as unknown as ExtensionDefinition)).toThrow(
      ExtensionDefinitionError,
    );
  });

  it('throws when the definition is not an object', () => {
    expect(() => defineExtension(null as unknown as ExtensionDefinition)).toThrow(
      ExtensionDefinitionError,
    );
  });

  it('throws ExcaliburError subclasses with the stable code extension_definition', () => {
    try {
      defineExtension({ ...validDefinition(), id: '' });
      expect.unreachable('defineExtension should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ExcaliburError);
      expect((error as ExcaliburError).code).toBe('extension_definition');
      expect((error as ExcaliburError).details).toMatchObject({ field: 'id' });
    }
  });
});

describe('isExcaliburExtension', () => {
  it('accepts values produced by defineExtension', () => {
    expect(isExcaliburExtension(defineExtension(validDefinition()))).toBe(true);
  });

  it('accepts structurally compatible plain objects (compiled entrypoints)', () => {
    expect(isExcaliburExtension(validDefinition())).toBe(true);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['string', 'linear'],
    ['missing register', { id: 'x', name: 'X', version: '1.0.0' }],
    ['empty id', { ...validDefinition(), id: ' ' }],
  ])('rejects %s', (_label, value) => {
    expect(isExcaliburExtension(value)).toBe(false);
  });
});

describe('registerExtension', () => {
  it('rejects values that are not extensions', async () => {
    await expect(
      registerExtension(
        { id: '', name: '', version: '', register: () => undefined },
        {
          contributions: { register: () => undefined } as never,
          hooks: {} as never,
        },
      ),
    ).rejects.toThrow(ExtensionDefinitionError);
  });
});
