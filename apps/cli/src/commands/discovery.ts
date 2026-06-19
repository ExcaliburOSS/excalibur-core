import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DiscoveryManager } from '@excalibur/core';
import {
  discoveryInputTypeSchema,
  type DiscoveryInputType,
  type DiscoveryRecord,
} from '@excalibur/shared';
import { DISCOVERY_QUESTION_PACKS } from '@excalibur/workflow-schema';
import type { Command } from 'commander';
import pc from 'picocolors';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import { loadGatewayContext } from '../lib/context';

interface DiscoveryOptions {
  type?: string;
  fromFile?: string;
  fromLinear?: string;
  fromJira?: string;
  fromGithubIssue?: string;
  yes?: boolean;
}

export interface DiscoveryFlowInput {
  input: string;
  inputType: DiscoveryInputType;
  yes: boolean;
  title?: string;
}

/** Next-step suggestions filtered by the deterministic recommendation. */
function nextSteps(record: DiscoveryRecord, title: string): string[] {
  const quoted = title.replace(/"/g, "'");
  switch (record.recommendation) {
    case 'agent_run_ready':
    case 'build_now':
      return [`excalibur run "${quoted}"`, `excalibur patch "${quoted}"`];
    case 'patch_ready':
      return [`excalibur patch "${quoted}"`];
    case 'plan_only':
      return [`excalibur ask "How should we approach: ${quoted}?"`];
    case 'refine_first':
    case 'split_scope':
      return ['Refine the open questions above, then run `excalibur discovery` again.'];
    case 'customer_validation':
    case 'prototype':
    case 'technical_spike':
      return ['Validate before building — see recommendation.md for the suggested experiment.'];
    case 'do_not_build':
      return [];
    default:
      return [];
  }
}

/**
 * The interactive Discovery flow (D-7, discovery-core.md §6), reused by
 * `excalibur run` when it recommends Discovery first. Questions are
 * skippable with an empty answer; `--yes`/non-TTY records them unanswered.
 */
export async function runDiscoveryFlow(deps: CliDeps, flow: DiscoveryFlowInput): Promise<void> {
  const repoRoot = deps.cwd();
  const title = flow.title ?? flow.input.split('\n')[0]?.slice(0, 120) ?? 'Discovery session';

  const manager = new DiscoveryManager(repoRoot);
  const session = manager.createSession({
    title,
    inputType: flow.inputType,
    source: 'cli',
    inputMarkdown: flow.input,
  });
  deps.ui.info(
    deps.t('discovery.sessionCreated', {
      id: session.id,
      inputType: flow.inputType,
      dir: session.dir,
    }),
  );

  const pack = DISCOVERY_QUESTION_PACKS[flow.inputType];
  deps.ui.write();
  deps.ui.info(deps.t('discovery.answerPrompt'));
  for (const question of pack) {
    const answer = await deps.ui.ask(`${pc.bold(question.text)}`, {
      yes: flow.yes,
      defaultAnswer: '',
    });
    manager.recordAnswer(session.id, {
      key: question.id,
      question: question.text,
      answer: answer.trim().length > 0 ? answer.trim() : null,
    });
  }

  const { gateway } = loadGatewayContext(repoRoot);
  const record = await manager.completeSession(session.id, gateway);

  const card = readFileSync(join(session.dir, 'readiness-assessment.md'), 'utf8');
  deps.ui.write();
  deps.ui.write(card);

  if (record.recommendation === 'do_not_build') {
    deps.ui.warn(deps.t('discovery.doNotBuild'));
  } else {
    const steps = nextSteps(record, title);
    if (steps.length > 0) {
      deps.ui.heading(deps.t('discovery.suggestedNextSteps'));
      for (const step of steps) {
        deps.ui.write(`  ${step}`);
      }
    }
  }
  deps.ui.info(deps.t('discovery.artifacts', { dir: session.dir }));
}

/**
 * `excalibur discovery "<idea>"` — local conversational pre-work flow
 * (never changes code; can recommend NOT building).
 */
export function registerDiscoveryCommand(program: Command, deps: CliDeps): void {
  program
    .command('discovery')
    .description('clarify an idea, ticket or initiative before building (Level 0/1)')
    .argument('[input...]', 'the idea / ticket text to clarify')
    .option('--type <type>', `input type: ${discoveryInputTypeSchema.options.join(', ')}`)
    .option('--from-file <path>', 'read the input from a file (customer feedback by default)')
    .option('--from-linear <id>', 'start from a Linear issue (available in M4)')
    .option('--from-jira <id>', 'start from a Jira issue (available in M4)')
    .option('--from-github-issue <id>', 'start from a GitHub issue (available in M4)')
    .option('-y, --yes', 'skip the questions (recorded as unanswered)')
    .action(async (inputWords: string[], options: DiscoveryOptions) => {
      if (
        options.fromLinear !== undefined ||
        options.fromJira !== undefined ||
        options.fromGithubIssue !== undefined
      ) {
        deps.ui.warn(deps.t('discovery.workItemSourcesM4'));
        return;
      }

      let inputType: DiscoveryInputType = 'idea';
      if (options.type !== undefined) {
        const parsed = discoveryInputTypeSchema.safeParse(options.type);
        if (!parsed.success) {
          throw new CliUsageError(
            deps.t('discovery.invalidType', {
              types: discoveryInputTypeSchema.options.join(', '),
              got: options.type,
            }),
          );
        }
        inputType = parsed.data;
      }

      let input = inputWords.join(' ').trim();
      let title: string | undefined;
      if (options.fromFile !== undefined) {
        const filePath = join(deps.cwd(), options.fromFile);
        if (!existsSync(filePath)) {
          throw new CliUsageError(deps.t('discovery.fileNotFound', { path: options.fromFile }));
        }
        input = readFileSync(filePath, 'utf8');
        title = `Feedback: ${basename(options.fromFile)}`;
        if (options.type === undefined) {
          inputType = 'customer_feedback';
        }
      }
      if (input.trim().length === 0) {
        throw new CliUsageError(deps.t('discovery.provideIdea'));
      }

      await runDiscoveryFlow(deps, {
        input,
        inputType,
        yes: options.yes === true,
        ...(title !== undefined ? { title } : {}),
      });
    });
}
