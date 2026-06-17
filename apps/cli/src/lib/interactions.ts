import {
  COMMAND_DEFAULTS,
  InteractionStore,
  PatchStore,
  checkPatchApplies,
  type AdditionalContextSource,
  type LocalPatch,
} from '@excalibur/core';
import { redactSecrets } from '@excalibur/model-gateway';
import type { ChatMessage } from '@excalibur/model-gateway';
import { AUTONOMY_LEVEL_LABELS, type AutonomyLevel } from '@excalibur/shared';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import pc from 'picocolors';
import type { CliDeps } from '../deps';
import {
  buildEffectiveContext,
  chatWithGuidance,
  loadConfigContext,
  loadGatewayContext,
  safetyLine,
  streamWithGuidance,
} from './context';

/**
 * Shared flow for the lightweight assistant commands (`ask`, `explain`,
 * `review`) and `patch` (Build Contract §4.9): build the effective
 * instruction context (ISD-5), call the gateway (MockProvider in M1), print
 * the markdown answer and persist the InteractionStore/PatchStore artifact
 * set (ONB-8).
 */

export interface InteractionCommandInput {
  command: 'ask' | 'explain' | 'review';
  /** MockProvider response kind (Build Contract §7). */
  kind: 'ask' | 'explain' | 'review';
  /** Content of `input.md` — the question/selection/diff. */
  input: string;
  /** The user prompt sent to the model. */
  prompt: string;
  /** Retrieved repo-context injected at precedence 6 (M2 retrieval). */
  additionalSources?: AdditionalContextSource[];
  /** Disable live streaming (the `--no-stream` flag). */
  noStream?: boolean;
}

const ROLE_LINES: Record<string, string> = {
  ask: 'You are the Excalibur repository assistant. Answer questions about this codebase.',
  explain: 'You are the Excalibur repository assistant. Explain the given code clearly.',
  review: 'You are the Excalibur code reviewer. Review the given code or diff.',
};

function commandDefaults(command: string): { workflow: string; autonomyLevel: AutonomyLevel } {
  const defaults = COMMAND_DEFAULTS[command] ?? COMMAND_DEFAULTS['ask'];
  return {
    workflow: defaults?.workflow ?? 'ask-repo',
    autonomyLevel: defaults?.autonomyLevel ?? 1,
  };
}

export async function runInteractionCommand(
  deps: CliDeps,
  input: InteractionCommandInput,
): Promise<void> {
  const repoRoot = deps.cwd();
  const { workflow, autonomyLevel } = commandDefaults(input.command);

  deps.ui.info(
    deps.t('interactions.headerNeverChanges', {
      command: input.command,
      workflow,
      autonomy: AUTONOMY_LEVEL_LABELS[autonomyLevel],
    }),
  );

  const effective = await buildEffectiveContext(deps, repoRoot, {
    workflowId: workflow,
    autonomyLevel,
    ...(input.additionalSources !== undefined
      ? { additionalSources: input.additionalSources }
      : {}),
  });
  for (const warning of effective.warnings) {
    deps.ui.warn(warning);
  }

  const gatewayContext = loadGatewayContext(repoRoot);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        effective.instructionsMarkdown.length > 0
          ? `${effective.instructionsMarkdown}\n\n${ROLE_LINES[input.kind]}`
          : (ROLE_LINES[input.kind] ?? ''),
    },
    { role: 'user', content: input.prompt },
  ];
  const chatInput = { messages, metadata: { kind: input.kind } };

  // Stream live in an interactive TTY (unless --no-stream); otherwise assemble
  // once. Either way the persisted artifact uses the assembled `output.content`,
  // so the transcript is byte-identical streamed vs. not.
  const streaming = deps.ui.isInteractive() && input.noStream !== true;
  let output;
  let provider: string;
  if (streaming) {
    deps.ui.write();
    const result = await streamWithGuidance(deps, gatewayContext, chatInput, (chunk) => {
      deps.ui.streamChunk(chunk);
    });
    deps.ui.write();
    deps.ui.write();
    output = result.output;
    provider = result.provider;
  } else {
    const result = await chatWithGuidance(deps, gatewayContext, chatInput);
    output = result.output;
    provider = result.provider;
    deps.ui.write();
    deps.ui.write(output.content);
    deps.ui.write();
  }

  const store = new InteractionStore(repoRoot);
  const interaction = store.create({
    command: input.command,
    workflow,
    autonomyLevel,
    model: output.model,
    provider,
    input: input.input,
    effectiveInstructions: effective.instructionsMarkdown,
    output: output.content,
    instructionSources: effective.sourcePaths,
    warnings: effective.warnings,
    costCents: output.costCents,
  });
  deps.ui.info(
    deps.t('interactions.savedInteraction', { id: interaction.id, dir: interaction.dir }),
  );
}

/** Pulls the unified diff out of a ```diff fenced block. */
export function extractUnifiedDiff(content: string): string | null {
  const match = /```diff\r?\n([\s\S]*?)\r?\n?```/.exec(content);
  const diff = match?.[1]?.trim();
  return diff !== undefined && diff.length > 0 ? diff : null;
}

/** Reads the affected file paths from `+++ b/<path>` lines of a unified diff. */
export function filesAffectedFromDiff(diff: string): string[] {
  const affected: string[] = [];
  for (const line of diff.split('\n')) {
    const match = /^\+\+\+ b\/(.+)$/.exec(line);
    const path = match?.[1]?.trim();
    if (path !== undefined && path.length > 0 && !affected.includes(path)) {
      affected.push(path);
    }
  }
  return affected;
}

/** Generates and stores a patch proposal; returns the stored artifact. */
/** Path-like tokens in a task ("src/math.ts", "lib/foo.py"), a rough file-mention proxy. */
const PATCH_PATH_PATTERN = /\b[\w.-]+(?:\/[\w.-]+)+\b/g;
/** Never read these into a model prompt, even if the task names them (secrets/keys). */
const PATCH_BLOCKED = /(^|\/)(\.env|\.git\/|node_modules\/)|\.(pem|key|p12|pfx)$/i;
/** Per-file content cap injected into the patch prompt. */
const PATCH_FILE_CAP = 8000;

/**
 * Gathers the CURRENT contents of files the task names, so the model can emit a
 * precise unified diff in ONE shot instead of (correctly) asking to read them
 * first — which is what strong agentic models like Kimi do when handed a blind
 * "propose a diff" prompt with no file context. Best-effort, redacted, capped;
 * skips secrets, missing files and oversized blobs.
 */
function gatherReferencedFiles(repoRoot: string, task: string): string {
  const mentioned = [...new Set(task.match(PATCH_PATH_PATTERN) ?? [])];
  const blocks: string[] = [];
  for (const rel of mentioned) {
    if (PATCH_BLOCKED.test(rel) || isAbsolute(rel)) continue;
    const abs = join(repoRoot, rel);
    // Stay inside the repo (no ../ escape) and only read real, reasonably-sized files.
    if (relative(repoRoot, abs).startsWith('..')) continue;
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
      const raw = readFileSync(abs, 'utf8');
      const capped = raw.length > PATCH_FILE_CAP ? `${raw.slice(0, PATCH_FILE_CAP)}\n… (truncated)` : raw;
      blocks.push(`Current contents of \`${rel}\`:\n\`\`\`\n${redactSecrets(capped)}\n\`\`\``);
    } catch {
      // Unreadable file → just skip it (the model can still propose a new file).
    }
  }
  return blocks.join('\n\n');
}

export async function generatePatch(deps: CliDeps, task: string): Promise<LocalPatch> {
  const repoRoot = deps.cwd();
  const { config } = loadConfigContext(repoRoot);
  const defaults = commandDefaults('patch');

  deps.ui.info(
    deps.t('interactions.patchHeader', {
      workflow: defaults.workflow,
      autonomy: AUTONOMY_LEVEL_LABELS[defaults.autonomyLevel],
    }),
  );
  deps.ui.info(safetyLine(deps.t, config));

  const effective = await buildEffectiveContext(deps, repoRoot, {
    workflowId: defaults.workflow,
    autonomyLevel: defaults.autonomyLevel,
  });
  for (const warning of effective.warnings) {
    deps.ui.warn(warning);
  }

  const gatewayContext = loadGatewayContext(repoRoot);
  // Give the model the current contents of any files the task names, so it can
  // emit a precise diff in one shot rather than asking to read them first.
  const fileContext = gatherReferencedFiles(repoRoot, task);
  const instruction =
    'You are the Excalibur implementer. Output ONLY a unified diff in a single ```diff ' +
    'fenced block (git-style, with ---/+++ headers and @@ hunks) that accomplishes the task — ' +
    'no prose, no questions, do not ask to see files (their current contents are provided ' +
    'below when relevant). For a new file, diff against /dev/null.';
  const userContent =
    fileContext.length > 0 ? `${fileContext}\n\nTask: ${task}` : `Task: ${task}`;
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        effective.instructionsMarkdown.length > 0
          ? `${effective.instructionsMarkdown}\n\n${instruction}`
          : instruction,
    },
    { role: 'user', content: userContent },
  ];
  const { output, provider } = await chatWithGuidance(deps, gatewayContext, {
    messages,
    metadata: { kind: 'patch' },
  });

  const diff = extractUnifiedDiff(output.content) ?? '';

  // Validate the proposed diff against the working tree (read-only, ISD-5).
  // `null` when there is no diff to validate; otherwise true/false is recorded
  // on the artifact and a non-applying diff surfaces a non-blocking warning.
  const validation = diff.length > 0 ? checkPatchApplies(repoRoot, diff) : null;
  const diffApplies = validation === null ? null : validation.applies;
  const validationWarnings =
    validation !== null && !validation.applies
      ? [
          deps.t('interactions.diffDidNotValidate', {
            reason: validation.reason ?? 'unknown reason',
          }),
        ]
      : [];

  const store = new PatchStore(repoRoot);
  const patch = store.create({
    command: 'patch',
    workflow: defaults.workflow,
    autonomyLevel: defaults.autonomyLevel,
    model: output.model,
    provider,
    input: task,
    effectiveInstructions: effective.instructionsMarkdown,
    diff,
    diffApplies,
    summary: output.content,
    instructionSources: effective.sourcePaths,
    warnings: [...effective.warnings, ...validationWarnings],
    costCents: output.costCents,
  });

  for (const warning of validationWarnings) {
    deps.ui.warn(warning);
  }

  const files = filesAffectedFromDiff(diff);
  deps.ui.write();
  deps.ui.heading(deps.t('interactions.patchTitle', { id: patch.id }));
  deps.ui.write(
    deps.t('interactions.filesAffected', {
      files: files.length > 0 ? files.join(', ') : deps.t('interactions.filesAffectedNone'),
    }),
  );
  deps.ui.write();
  deps.ui.write(output.content);
  deps.ui.write();
  if (diff.length > 0) {
    deps.ui.write(pc.dim('--- diff.patch ---'));
    deps.ui.write(diff);
    deps.ui.write();
  }
  deps.ui.info(deps.t('interactions.savedPatch', { id: patch.id, dir: patch.dir }));
  return patch;
}
