import { DEFAULT_WORKFLOWS } from '@excalibur/workflow-schema';
import type { ExtensionManifest } from '@excalibur/extension-runtime';
import {
  BUILT_IN_EXTENSION_VERSION,
  builtInContribution,
  type BuiltInExtensionPack,
} from './types';

const EXTENSION_ID = 'core-workflows';

const manifest: ExtensionManifest = {
  id: EXTENSION_ID,
  name: 'Core Workflows',
  version: BUILT_IN_EXTENSION_VERSION,
  kind: 'declarative',
  description:
    'The 14 built-in Excalibur workflows, from read-only repository Q&A to fully gated agentic delivery.',
  contributes: {
    workflows: DEFAULT_WORKFLOWS.map((entry) => entry.id),
  },
};

/**
 * `core-workflows` — wraps `DEFAULT_WORKFLOWS` from `@excalibur/workflow-schema`
 * (the single source of truth) as `workflow` contributions.
 */
export const CORE_WORKFLOWS_PACK: BuiltInExtensionPack = {
  manifest,
  contributions: DEFAULT_WORKFLOWS.map((entry) =>
    builtInContribution(EXTENSION_ID, 'workflow', entry.id, entry.definition),
  ),
};
