import { minimatch } from 'minimatch';
import {
  WorkflowValidationError,
  type AutonomyLevel,
  type ExcaliburConfig,
  type ExecutionStyle,
} from '@excalibur/shared';
import type { WorkflowDefinition } from '@excalibur/workflow-schema';

/**
 * Workflow selection (Build Contract §4.6). Priority:
 *
 * 1. explicit workflow id;
 * 2. `config.workflows.byPath` pattern match on the touched paths;
 * 3. autonomy level / execution style mapping table.
 *
 * Falls back to `standard-feature` and explains the decision in `reason`.
 */

export interface SelectWorkflowInput {
  config: ExcaliburConfig;
  catalog: ReadonlyArray<{ id: string; definition: WorkflowDefinition }>;
  autonomyLevel: AutonomyLevel;
  executionStyle: ExecutionStyle;
  taskType?: string;
  paths?: string[];
  explicitWorkflow?: string;
}

export interface SelectWorkflowResult {
  workflowId: string;
  definition: WorkflowDefinition;
  reason: string;
}

const FALLBACK_WORKFLOW = 'standard-feature';

function findInCatalog(
  catalog: SelectWorkflowInput['catalog'],
  id: string,
): WorkflowDefinition | undefined {
  return catalog.find((entry) => entry.id === id)?.definition;
}

/** The level/style mapping table (Build Contract §4.6). */
function mapLevelAndStyle(input: SelectWorkflowInput): { id: string; reason: string } {
  const { autonomyLevel, executionStyle, taskType, config } = input;

  switch (autonomyLevel) {
    case 0:
      if (taskType === 'security') {
        return {
          id: 'security-review',
          reason: 'Level 0 with a security task maps to the security-review workflow.',
        };
      }
      return { id: 'review-only', reason: 'Level 0 (Review) maps to the review-only workflow.' };
    case 1:
      return { id: 'assist', reason: 'Level 1 (Assist) maps to the assist workflow.' };
    case 2:
      if (taskType === 'refactor') {
        return {
          id: 'safe-refactor',
          reason: 'Level 2 with a refactor task maps to the safe-refactor workflow.',
        };
      }
      return {
        id: 'propose-patch',
        reason: 'Level 2 (Propose Patch) maps to the propose-patch workflow.',
      };
    case 3:
      switch (executionStyle) {
        case 'fast':
          return { id: 'fast-fix', reason: 'Level 3 with the fast style maps to fast-fix.' };
        case 'structured':
          return {
            id: 'structured-feature',
            reason: 'Level 3 with the structured style maps to structured-feature.',
          };
        case 'explore':
          return {
            id: 'explore-alternatives',
            reason: 'Level 3 with the explore style maps to explore-alternatives.',
          };
        case 'careful':
          return {
            id: 'standard-feature',
            reason: 'Level 3 with the careful style maps to standard-feature.',
          };
        case 'team_default': {
          const byTaskType =
            taskType !== undefined ? config.workflows?.byTaskType?.[taskType] : undefined;
          if (byTaskType !== undefined) {
            return {
              id: byTaskType,
              reason: `Level 3 team default: workflows.byTaskType maps task type "${taskType ?? ''}" to "${byTaskType}".`,
            };
          }
          const configured = config.workflows?.default;
          if (configured !== undefined) {
            return {
              id: configured,
              reason: `Level 3 team default: workflows.default is "${configured}".`,
            };
          }
          return {
            id: FALLBACK_WORKFLOW,
            reason: 'Level 3 team default with no configured default maps to standard-feature.',
          };
        }
        default:
          return {
            id: FALLBACK_WORKFLOW,
            reason: `Level 3 with the unmapped "${executionStyle}" style falls back to standard-feature.`,
          };
      }
    case 4:
      switch (executionStyle) {
        case 'explore':
          return {
            id: 'explore-alternatives',
            reason: 'Level 4 with the explore style maps to explore-alternatives.',
          };
        case 'careful':
          return {
            id: 'human-gated',
            reason: 'Level 4 with the careful style maps to the human-gated workflow.',
          };
        default:
          // Honour sensitive task types at the highest autonomy too — a security
          // or migration task needs its specialized careful workflow, not the
          // generic structured-feature (mirrors L0 security / L2 refactor).
          if (taskType === 'security') {
            return {
              id: 'security-review',
              reason: 'Level 4 with a security task maps to the security-review workflow.',
            };
          }
          if (taskType === 'migration') {
            return {
              id: 'migration',
              reason: 'Level 4 with a migration task maps to the migration workflow.',
            };
          }
          return {
            id: 'structured-feature',
            reason: `Level 4 with the "${executionStyle}" style maps to structured-feature.`,
          };
      }
    default: {
      // Exhaustiveness guard: autonomyLevel is 0..4.
      return {
        id: FALLBACK_WORKFLOW,
        reason: 'Unknown autonomy level falls back to standard-feature.',
      };
    }
  }
}

export function selectWorkflow(input: SelectWorkflowInput): SelectWorkflowResult {
  const resolve = (id: string, reason: string): SelectWorkflowResult => {
    const definition = findInCatalog(input.catalog, id);
    if (definition !== undefined) {
      return { workflowId: id, definition, reason };
    }
    const fallback = findInCatalog(input.catalog, FALLBACK_WORKFLOW);
    if (fallback !== undefined) {
      return {
        workflowId: FALLBACK_WORKFLOW,
        definition: fallback,
        reason: `${reason} Workflow "${id}" is not in the catalog — falling back to standard-feature.`,
      };
    }
    throw new WorkflowValidationError(
      `Neither workflow "${id}" nor the fallback "${FALLBACK_WORKFLOW}" exist in the catalog.`,
      { workflowId: id, catalogIds: input.catalog.map((entry) => entry.id) },
    );
  };

  // 1. Explicit workflow wins.
  if (input.explicitWorkflow !== undefined && input.explicitWorkflow.length > 0) {
    return resolve(
      input.explicitWorkflow,
      `Explicitly requested workflow "${input.explicitWorkflow}".`,
    );
  }

  // 2. config.workflows.byPath pattern match.
  const byPath = input.config.workflows?.byPath ?? {};
  for (const [pattern, workflowId] of Object.entries(byPath)) {
    const matched = (input.paths ?? []).find((path) => minimatch(path, pattern, { dot: true }));
    if (matched !== undefined) {
      return resolve(
        workflowId,
        `Path "${matched}" matches workflows.byPath pattern "${pattern}" → "${workflowId}".`,
      );
    }
  }

  // 3. Level/style mapping table.
  const mapped = mapLevelAndStyle(input);
  return resolve(mapped.id, mapped.reason);
}
