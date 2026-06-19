/**
 * @excalibur/extension-runtime — manifest schema/loader/validator, extension
 * and contribution registries, declarative + local programmatic loaders,
 * hook registry and permission validation (extensions spec §3, §6, §7, §8).
 */

export {
  EXTENSION_KINDS,
  PERMISSION_CATEGORIES,
  extensionConfigFieldSchema,
  extensionContributionsSchema,
  extensionManifestSchema,
  extensionPermissionsSchema,
  loadManifest,
  validateManifest,
  type ExtensionConfigField,
  type ExtensionContributions,
  type ExtensionKind,
  type ExtensionManifest,
  type ExtensionPermissions,
  type ManifestValidationResult,
  type PermissionCategory,
} from './manifest';

export {
  EXTENSIONS_FILE_RELATIVE_PATH,
  extensionsFileSchema,
  loadExtensionsFile,
  type ExtensionsFileConfig,
} from './extensions-file';

export {
  CONTRIBUTION_KINDS,
  CONTRIBUTION_SOURCES,
  ContributionRegistry,
  DECLARATIVE_CONTRIBUTION_KINDS,
  PROGRAMMATIC_CONTRIBUTION_KINDS,
  type Contribution,
  type ContributionKind,
  type ContributionSource,
  type ProgrammaticContributionKind,
} from './contributions';

export {
  EXCALIBUR_HOOKS,
  HookRegistry,
  type ExcaliburHook,
  type HookHandler,
  type HookHandlerError,
} from './hooks';

export { ExtensionRegistry, type BuiltInExtensionPack, type LoadedExtension } from './registry';

export { PROJECT_EXTENSION_ID, loadExtensions, type LoadExtensionsInput } from './loader';

export { validatePermissions } from './permissions';
