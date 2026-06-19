import { DEFAULT_METHODOLOGIES } from '@excalibur/workflow-schema';
import type { ExtensionManifest } from '@excalibur/extension-runtime';
import {
  BUILT_IN_EXTENSION_VERSION,
  builtInContribution,
  type BuiltInExtensionPack,
} from './types';

const EXTENSION_ID = 'core-methodologies';

const manifest: ExtensionManifest = {
  id: EXTENSION_ID,
  name: 'Core Methodologies',
  version: BUILT_IN_EXTENSION_VERSION,
  kind: 'declarative',
  description:
    'The 14 built-in Excalibur methodologies covering delivery, review, safety and pre-work styles.',
  contributes: {
    methodologies: DEFAULT_METHODOLOGIES.map((entry) => entry.id),
  },
};

/**
 * `core-methodologies` — wraps `DEFAULT_METHODOLOGIES` from
 * `@excalibur/workflow-schema` (the single source of truth) as `methodology`
 * contributions.
 */
export const CORE_METHODOLOGIES_PACK: BuiltInExtensionPack = {
  manifest,
  contributions: DEFAULT_METHODOLOGIES.map((entry) =>
    builtInContribution(EXTENSION_ID, 'methodology', entry.id, entry.definition),
  ),
};
