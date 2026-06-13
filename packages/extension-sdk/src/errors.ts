import { ExcaliburError } from '@excalibur/shared';

/**
 * Thrown when an extension definition or a contribution passed to one of the
 * `ExtensionContext` registries is structurally invalid (Build Contract §2.6:
 * every thrown error is an `ExcaliburError` subclass).
 */
export class ExtensionDefinitionError extends ExcaliburError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'extension_definition', details);
  }
}
