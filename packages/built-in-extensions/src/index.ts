/**
 * @excalibur/built-in-extensions — the default Excalibur catalogs packaged as
 * declarative extension packs (contract §4.6e, extensions spec §11 rule 8).
 *
 * Every pack wraps constants owned by `@excalibur/workflow-schema` and
 * `@excalibur/shared` where they exist — single source of truth, no
 * duplicated content. `loadExtensions({ repoRoot, builtIns: BUILT_IN_EXTENSIONS })`
 * registers them before project-level extensions, so project files override
 * built-ins with zero special-casing.
 */
import type { BuiltInExtensionPack } from './types';
import { CORE_METHODOLOGIES_PACK } from './core-methodologies';
import { CORE_WORKFLOWS_PACK } from './core-workflows';
import { DISCOVERY_PACK } from './discovery-pack';
import { CORE_PROMPTS_PACK } from './core-prompts';
import { CORE_POLICIES_PACK } from './core-policies';
import { CORE_REPORTS_PACK } from './core-reports';
import { CORE_COMMAND_MAPPINGS_PACK } from './core-command-mappings';

export { BUILT_IN_EXTENSION_VERSION, builtInContribution, type BuiltInExtensionPack } from './types';
export { CORE_METHODOLOGIES_PACK } from './core-methodologies';
export { CORE_WORKFLOWS_PACK } from './core-workflows';
export {
  DISCOVERY_PACK,
  DISCOVERY_QUESTION_PACK_IDS,
  DISCOVERY_ROLE_DEFINITIONS,
  DISCOVERY_SYNTHESIS_PROMPT,
  MVP_SCOPE_TEMPLATE,
  READINESS_ASSESSMENT_TEMPLATE,
  REFINED_TICKET_TEMPLATE,
} from './discovery-pack';
export { CODE_REVIEW_PROMPT, CORE_PROMPTS_PACK, PR_SUMMARY_PROMPT } from './core-prompts';
export {
  CORE_POLICIES_PACK,
  STANDARD_SAFE_BLOCKED_PATHS,
  STANDARD_SAFE_POLICY_PRESET,
} from './core-policies';
export { CORE_REPORTS_PACK, DAILY_SUMMARY_REPORT, WEEKLY_PLAN_REPORT } from './core-reports';
export { CORE_COMMAND_MAPPINGS_PACK, WORK_ITEM_COMMAND_MAPPING } from './core-command-mappings';

/**
 * All built-in extension packs, in registration order. Pinned API
 * (contract §4.6e): consumed by `loadExtensions` in
 * `@excalibur/extension-runtime` via `createExtensionHost` in `@excalibur/core`.
 */
export const BUILT_IN_EXTENSIONS: ReadonlyArray<BuiltInExtensionPack> = [
  CORE_METHODOLOGIES_PACK,
  CORE_WORKFLOWS_PACK,
  DISCOVERY_PACK,
  CORE_PROMPTS_PACK,
  CORE_POLICIES_PACK,
  CORE_REPORTS_PACK,
  CORE_COMMAND_MAPPINGS_PACK,
];

/** Look up a built-in pack by its manifest id. */
export function getBuiltInExtension(id: string): BuiltInExtensionPack | undefined {
  return BUILT_IN_EXTENSIONS.find((pack) => pack.manifest.id === id);
}
