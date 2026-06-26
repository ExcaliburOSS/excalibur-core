/**
 * @excalibur/work-items — normalized work item model, provider interface,
 * `@excalibur` command parser, comment templates and the deterministic mock
 * provider (Build Contract §4.7, docs/spec/work-items-core.md).
 */

export {
  workItemProviderTypeSchema,
  normalizedWorkItemUserSchema,
  normalizedWorkItemCommentSchema,
  normalizedWorkItemLinkTypeSchema,
  normalizedWorkItemLinkSchema,
  normalizedWorkItemSchema,
} from './types';
export type {
  WorkItemProviderType,
  NormalizedWorkItemUser,
  NormalizedWorkItemComment,
  NormalizedWorkItemLinkType,
  NormalizedWorkItemLink,
  NormalizedWorkItemChecklistItem,
  NormalizedWorkItem,
} from './types';

export {
  getWorkItemInputSchema,
  listWorkItemsInputSchema,
  addWorkItemCommentInputSchema,
  updateWorkItemStatusInputSchema,
  linkPullRequestInputSchema,
} from './provider';
export type {
  GetWorkItemInput,
  ListWorkItemsInput,
  AddWorkItemCommentInput,
  UpdateWorkItemStatusInput,
  LinkPullRequestInput,
  WorkItemProvider,
} from './provider';

export {
  EXCALIBUR_COMMANDS,
  PLANNING_SUBCOMMANDS,
  DISCOVERY_SUBCOMMANDS,
  parseExcaliburCommand,
  commandToAction,
} from './commands';
export type {
  ExcaliburCommand,
  PlanningSubcommand,
  DiscoverySubcommand,
  ParsedExcaliburCommand,
  WorkItemCommandAction,
} from './commands';

export {
  COMMENT_TEMPLATE_NAMES,
  COMMENT_TEMPLATES,
  TemplateRenderError,
  renderCommentTemplate,
} from './templates';
export type { CommentTemplateName } from './templates';

export { GitHubCliProvider, mapGhIssue } from './github-cli-provider';
export type { GhRunner } from './github-cli-provider';

export { MockWorkItemProvider } from './mock-provider';

export { LocalWorkItemProvider } from './local-provider';
export type { CreateWorkItemInput, UpdateWorkItemInput, WorkItemBoardLane } from './local-provider';
export {
  WORK_ITEM_LANES,
  WORK_ITEM_LANE_LABELS,
  laneOf,
  isWorkItemLane,
  type WorkItemLane,
} from './lanes';
