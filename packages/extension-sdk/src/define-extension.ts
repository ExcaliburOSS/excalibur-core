import { ExtensionDefinitionError } from './errors';
import {
  createExtensionContext,
  type CreateExtensionContextInput,
  type ExtensionContext,
} from './context';

/**
 * `defineExtension` — the entrypoint of every programmatic extension
 * (Build Contract §4.6d, extensions-spec.md §5).
 *
 * ```ts
 * export default defineExtension({
 *   id: 'linear',
 *   name: 'Linear',
 *   version: '0.1.0',
 *   register(ctx) {
 *     ctx.workItems.registerProvider(new LinearWorkItemProvider());
 *   },
 * });
 * ```
 */

/** Author-side extension definition. */
export interface ExtensionDefinition {
  /** Stable extension id; must match the manifest id (e.g. `linear`). */
  id: string;
  /** Human-readable extension name. */
  name: string;
  /** Extension version (semver recommended). */
  version: string;
  description?: string;
  /** Called once at load time to register the extension's contributions. */
  register(ctx: ExtensionContext): void | Promise<void>;
}

/** A validated, frozen extension as returned by `defineExtension`. */
export type ExcaliburExtension = Readonly<ExtensionDefinition>;

function assertNonEmpty(def: Record<string, unknown>, field: 'id' | 'name' | 'version'): string {
  const value = def[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ExtensionDefinitionError(`defineExtension requires a non-empty string "${field}"`, {
      field,
      received: typeof value,
    });
  }
  return value;
}

/**
 * Validates and freezes an extension definition. Throws
 * `ExtensionDefinitionError` (an `ExcaliburError`, code `extension_definition`)
 * when the definition is structurally invalid.
 */
export function defineExtension(def: ExtensionDefinition): ExcaliburExtension {
  if (typeof def !== 'object' || def === null) {
    throw new ExtensionDefinitionError('defineExtension requires a definition object', {
      received: def === null ? 'null' : typeof def,
    });
  }
  const record = def as unknown as Record<string, unknown>;
  const id = assertNonEmpty(record, 'id');
  if (/\s/.test(id)) {
    throw new ExtensionDefinitionError(`Extension id "${id}" must not contain whitespace`, {
      field: 'id',
      value: id,
    });
  }
  const name = assertNonEmpty(record, 'name');
  const version = assertNonEmpty(record, 'version');
  if (record['description'] !== undefined && typeof record['description'] !== 'string') {
    throw new ExtensionDefinitionError('Extension "description" must be a string when present', {
      field: 'description',
      received: typeof record['description'],
    });
  }
  if (typeof record['register'] !== 'function') {
    throw new ExtensionDefinitionError(`Extension "${id}" must provide a register(ctx) function`, {
      field: 'register',
      received: typeof record['register'],
    });
  }
  const extension: ExtensionDefinition = {
    id,
    name,
    version,
    register: def.register,
  };
  if (def.description !== undefined) {
    extension.description = def.description;
  }
  return Object.freeze(extension);
}

/** Narrowing guard for values loaded from a compiled extension entrypoint. */
export function isExcaliburExtension(value: unknown): value is ExcaliburExtension {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    record['id'].trim().length > 0 &&
    typeof record['name'] === 'string' &&
    typeof record['version'] === 'string' &&
    typeof record['register'] === 'function'
  );
}

/** Host-side input for `registerExtension`; the id comes from the extension. */
export type RegisterExtensionInput = Omit<CreateExtensionContextInput, 'extensionId'>;

/**
 * Convenience host helper: builds the context for `extension` and awaits its
 * `register()`. Returns the context so the host can keep logger/config refs.
 */
export async function registerExtension(
  extension: ExcaliburExtension,
  input: RegisterExtensionInput,
): Promise<ExtensionContext> {
  if (!isExcaliburExtension(extension)) {
    throw new ExtensionDefinitionError(
      'registerExtension requires an extension created with defineExtension',
    );
  }
  const ctx = createExtensionContext({ ...input, extensionId: extension.id });
  await extension.register(ctx);
  return ctx;
}
