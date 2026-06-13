import { DEFAULT_BLOCKED_PATHS } from '@excalibur/shared';
import type { PolicyPresetDefinition } from '@excalibur/declarative-schemas';
import type { ExtensionManifest } from '@excalibur/extension-runtime';
import { BUILT_IN_EXTENSION_VERSION, builtInContribution, type BuiltInExtensionPack } from './types';

const EXTENSION_ID = 'core-policies';

/**
 * Blocked paths of the `standard-safe` preset (onboarding spec §5):
 * the shared `DEFAULT_BLOCKED_PATHS` (OSS spec §17) extended with
 * certificate stores and the git object database.
 */
export const STANDARD_SAFE_BLOCKED_PATHS: ReadonlyArray<string> = [
  ...DEFAULT_BLOCKED_PATHS,
  '**/*.p12',
  '**/*.pfx',
  '.git/**',
];

/**
 * The `standard-safe` policy preset (onboarding spec §5; supersedes the
 * earlier `safe-defaults` id). Rules are evaluated top-down, first match
 * wins: reads are free except on blocked paths, every mutation asks, push
 * and external network access are disabled, secrets are redacted from
 * prompts and logs.
 */
export const STANDARD_SAFE_POLICY_PRESET: PolicyPresetDefinition = {
  id: 'standard-safe',
  type: 'policy_preset',
  name: 'Standard Safe',
  description:
    'Default Excalibur safety preset: no files are modified, no patches applied and no unknown commands run without approval; push and external network access are disabled; secrets are redacted.',
  rules: [
    {
      id: 'blocked-paths',
      when: { filePathMatches: [...STANDARD_SAFE_BLOCKED_PATHS] },
      decision: 'deny',
    },
    { id: 'read-files', when: { action: 'read' }, decision: 'allow' },
    { id: 'write-files', when: { action: 'write' }, decision: 'require_approval' },
    { id: 'apply-patch', when: { action: 'apply_patch' }, decision: 'require_approval' },
    {
      id: 'run-detected-test-command',
      when: { action: 'run_command', command: 'test' },
      decision: 'require_approval',
    },
    {
      id: 'run-detected-lint-command',
      when: { action: 'run_command', command: 'lint' },
      decision: 'require_approval',
    },
    {
      id: 'run-detected-typecheck-command',
      when: { action: 'run_command', command: 'typecheck' },
      decision: 'require_approval',
    },
    {
      id: 'run-detected-build-command',
      when: { action: 'run_command', command: 'build' },
      decision: 'require_approval',
    },
    { id: 'run-unknown-command', when: { action: 'run_command' }, decision: 'require_approval' },
    { id: 'create-branch', when: { action: 'create_branch' }, decision: 'require_approval' },
    { id: 'git-push', when: { action: 'push' }, decision: 'deny' },
    { id: 'open-pull-request', when: { action: 'open_pr' }, decision: 'require_approval' },
    { id: 'external-network', when: { action: 'network' }, decision: 'deny' },
    { id: 'redact-secrets-in-prompts', when: { action: 'prompt' }, decision: 'redact' },
    { id: 'redact-secrets-in-logs', when: { action: 'log' }, decision: 'redact' },
  ],
};

const manifest: ExtensionManifest = {
  id: EXTENSION_ID,
  name: 'Core Policies',
  version: BUILT_IN_EXTENSION_VERSION,
  kind: 'declarative',
  description:
    'Built-in safety policy presets. Provides the standard-safe preset active by default in every Excalibur repository.',
  contributes: {
    policyPresets: [STANDARD_SAFE_POLICY_PRESET.id],
  },
};

/** `core-policies` — the `standard-safe` policy preset. */
export const CORE_POLICIES_PACK: BuiltInExtensionPack = {
  manifest,
  contributions: [
    builtInContribution(
      EXTENSION_ID,
      'policy_preset',
      STANDARD_SAFE_POLICY_PRESET.id,
      STANDARD_SAFE_POLICY_PRESET,
    ),
  ],
};
