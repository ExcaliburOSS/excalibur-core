import type { CommandMappingDefinition } from '@excalibur/declarative-schemas';
import type { ExtensionManifest } from '@excalibur/extension-runtime';
import { BUILT_IN_EXTENSION_VERSION, builtInContribution, type BuiltInExtensionPack } from './types';

const EXTENSION_ID = 'core-command-mappings';

/**
 * `work-item-commands` — the `@excalibur <command>` vocabulary of the common
 * comment parser, mirroring the command → action table of the work-items
 * spec §4 plus the Agentic Agile `daily`/`planning` commands and the
 * Discovery commands (discovery spec §7) parsed by the same parser. The
 * executable mapping lives in `@excalibur/work-items` (`commandToAction`);
 * this declarative mirror makes the table inspectable and overridable like
 * any other contribution.
 */
export const WORK_ITEM_COMMAND_MAPPING: CommandMappingDefinition = {
  id: 'work-item-commands',
  type: 'command_mapping',
  name: 'Work Item Commands',
  description:
    'Maps @excalibur commands in work-item comments to Excalibur interactions, patches and runs.',
  commands: [
    {
      trigger: '@excalibur refine',
      action: 'interaction',
      defaults: { interactionType: 'work_item_refinement', autonomyLevel: 0 },
    },
    {
      trigger: '@excalibur plan',
      action: 'interaction',
      defaults: { interactionType: 'work_item_plan', autonomyLevel: 0 },
    },
    {
      trigger: '@excalibur review',
      action: 'interaction',
      defaults: { interactionType: 'work_item_review', autonomyLevel: 0 },
    },
    {
      trigger: '@excalibur suggest-patch',
      action: 'patch',
      defaults: { variant: 'suggest_patch', autonomyLevel: 2 },
    },
    {
      trigger: '@excalibur generate-tests',
      action: 'patch',
      defaults: { variant: 'generate_tests', autonomyLevel: 2 },
    },
    {
      trigger: '@excalibur implement',
      action: 'run',
      defaults: { autonomyLevel: 3, executionStyle: 'team_default' },
    },
    {
      trigger: '@excalibur careful',
      action: 'run',
      defaults: { autonomyLevel: 4, executionStyle: 'careful' },
    },
    {
      trigger: '@excalibur explore',
      action: 'run',
      defaults: { autonomyLevel: 3, executionStyle: 'explore', output: 'alternatives' },
    },
    { trigger: '@excalibur status', action: 'status' },
    { trigger: '@excalibur cancel', action: 'cancel' },
    { trigger: '@excalibur daily', action: 'daily' },
    {
      trigger: '@excalibur planning',
      action: 'planning',
      defaults: {
        subcommands: [
          'start',
          'propose',
          'approve',
          'revise',
          'add',
          'remove',
          'owner',
          'careful',
          'run',
        ],
      },
    },
    {
      trigger: '@excalibur discovery',
      action: 'discovery',
      defaults: {
        subcommands: ['complete', 'create-linear', 'update-ticket', 'create-run', 'save-decision'],
      },
    },
    {
      trigger: '@excalibur readiness',
      action: 'discovery',
      defaults: { discoveryAction: 'readiness' },
    },
    {
      trigger: '@excalibur acceptance-criteria',
      action: 'discovery',
      defaults: { discoveryAction: 'acceptance-criteria' },
    },
    {
      trigger: '@excalibur split-scope',
      action: 'discovery',
      defaults: { discoveryAction: 'split-scope' },
    },
  ],
};

const manifest: ExtensionManifest = {
  id: EXTENSION_ID,
  name: 'Core Command Mappings',
  version: BUILT_IN_EXTENSION_VERSION,
  kind: 'declarative',
  description:
    'Built-in mapping of @excalibur work-item comment commands to Excalibur actions.',
  contributes: {
    commandMappings: [WORK_ITEM_COMMAND_MAPPING.id],
  },
};

/** `core-command-mappings` — the work-item-commands mapping. */
export const CORE_COMMAND_MAPPINGS_PACK: BuiltInExtensionPack = {
  manifest,
  contributions: [
    builtInContribution(
      EXTENSION_ID,
      'command_mapping',
      WORK_ITEM_COMMAND_MAPPING.id,
      WORK_ITEM_COMMAND_MAPPING,
    ),
  ],
};
