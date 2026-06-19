import type { PromptTemplateDefinition } from '@excalibur/declarative-schemas';
import type { ExtensionManifest } from '@excalibur/extension-runtime';
import {
  BUILT_IN_EXTENSION_VERSION,
  builtInContribution,
  type BuiltInExtensionPack,
} from './types';

const EXTENSION_ID = 'core-prompts';

/** Prompt used by the `pull_request` phase to draft `pr-summary.md`. */
export const PR_SUMMARY_PROMPT: PromptTemplateDefinition = {
  id: 'pr-summary',
  type: 'prompt_template',
  name: 'Pull Request Summary',
  description: 'Drafts a pull request description from the task, the diff and the test results.',
  template: `Summarize the change below as a pull request description.

Task: {{task}}

## Diff
{{diff}}

## Test results
{{testResults}}

Write markdown with the sections: Summary, Changes, Testing, Risks.
Keep it short and factual. Never claim tests passed unless the test results
above say so, and call out any files that reviewers should look at first.
`,
};

/** Prompt used by review phases (`review-only`, `pr-review`, `agent_review`). */
export const CODE_REVIEW_PROMPT: PromptTemplateDefinition = {
  id: 'code-review',
  type: 'prompt_template',
  name: 'Code Review',
  description: 'Reviews a diff for correctness, security, performance and missing tests.',
  template: `Review the following diff as a senior engineer.

Task context: {{task}}

## Diff
{{diff}}

Look for correctness bugs, missing error handling, security issues
(secrets, injection, authorization), performance problems and missing tests.
Report findings as a markdown list ordered by severity; for each finding give
the file, the location and a concrete suggestion. If nothing blocks merging,
say "No blocking issues found." and list at most three optional improvements.
`,
};

const PROMPTS: ReadonlyArray<PromptTemplateDefinition> = [PR_SUMMARY_PROMPT, CODE_REVIEW_PROMPT];

const manifest: ExtensionManifest = {
  id: EXTENSION_ID,
  name: 'Core Prompts',
  version: BUILT_IN_EXTENSION_VERSION,
  kind: 'declarative',
  description: 'Built-in prompt templates for pull request summaries and code review.',
  contributes: {
    promptTemplates: PROMPTS.map((definition) => definition.id),
  },
};

/** `core-prompts` — the pr-summary and code-review prompt templates. */
export const CORE_PROMPTS_PACK: BuiltInExtensionPack = {
  manifest,
  contributions: PROMPTS.map((definition) =>
    builtInContribution(EXTENSION_ID, 'prompt_template', definition.id, definition),
  ),
};
