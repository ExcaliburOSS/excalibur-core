import { z } from 'zod';

/**
 * Normalized work item model (docs/spec/work-items-core.md §1–§2).
 *
 * The TS types are hand-written to match the spec exactly (e.g. `raw` is a
 * required `unknown` property, which zod cannot infer as required). The zod
 * schemas validate the same shapes at runtime; compile-time assertions at the
 * bottom of this file keep them in sync.
 */

export const workItemProviderTypeSchema = z.enum([
  'local',
  'linear',
  'jira',
  'github_issues',
  'gitlab_issues',
  'shortcut',
  'azure_devops',
  'youtrack',
]);
export type WorkItemProviderType = z.infer<typeof workItemProviderTypeSchema>;

export const normalizedWorkItemUserSchema = z.object({
  externalId: z.string().nullable(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  username: z.string().nullable(),
});
export type NormalizedWorkItemUser = z.infer<typeof normalizedWorkItemUserSchema>;

export type NormalizedWorkItemComment = {
  externalId: string;
  body: string;
  author: NormalizedWorkItemUser | null;
  createdAt: string | null;
  updatedAt: string | null;
  raw: unknown;
};

export const normalizedWorkItemCommentSchema = z.object({
  externalId: z.string(),
  body: z.string(),
  author: normalizedWorkItemUserSchema.nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  raw: z.unknown(),
});

export const normalizedWorkItemLinkTypeSchema = z.enum([
  'pull_request',
  'commit',
  'document',
  'url',
  'issue',
  'other',
]);
export type NormalizedWorkItemLinkType = z.infer<typeof normalizedWorkItemLinkTypeSchema>;

export type NormalizedWorkItemLink = {
  type: NormalizedWorkItemLinkType;
  url: string;
  title: string | null;
  raw: unknown;
};

export const normalizedWorkItemLinkSchema = z.object({
  type: normalizedWorkItemLinkTypeSchema,
  url: z.string(),
  title: z.string().nullable(),
  raw: z.unknown(),
});

export type NormalizedWorkItem = {
  provider: WorkItemProviderType;
  externalId: string;
  key: string;
  url: string;
  title: string;
  description: string | null;
  status: string | null;
  priority: string | null;
  labels: string[];
  assignee: NormalizedWorkItemUser | null;
  reporter: NormalizedWorkItemUser | null;
  project: string | null;
  team: string | null;
  cycleOrSprint: string | null;
  parentExternalId: string | null;
  comments: NormalizedWorkItemComment[];
  links: NormalizedWorkItemLink[];
  createdAt: string | null;
  updatedAt: string | null;
  /**
   * Native kanban rank within the item's lane (ascending). Set by the local
   * store (WK1) for board ordering; remote providers leave it undefined.
   */
  order?: number;
  raw: unknown;
};

export const normalizedWorkItemSchema = z.object({
  provider: workItemProviderTypeSchema,
  externalId: z.string(),
  key: z.string(),
  url: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.string().nullable(),
  priority: z.string().nullable(),
  labels: z.array(z.string()),
  assignee: normalizedWorkItemUserSchema.nullable(),
  reporter: normalizedWorkItemUserSchema.nullable(),
  project: z.string().nullable(),
  team: z.string().nullable(),
  cycleOrSprint: z.string().nullable(),
  parentExternalId: z.string().nullable(),
  comments: z.array(normalizedWorkItemCommentSchema),
  links: z.array(normalizedWorkItemLinkSchema),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  order: z.number().optional(),
  raw: z.unknown(),
});

/*
 * Compile-time guards: the hand-written contract types must stay assignable to
 * the schema output types (zod infers `raw` as optional, so the inverse
 * direction does not hold — the hand-written types are the public contract).
 */
type AssertAssignable<T extends U, U> = T;
type _CommentMatchesSchema = AssertAssignable<
  NormalizedWorkItemComment,
  z.infer<typeof normalizedWorkItemCommentSchema>
>;
type _LinkMatchesSchema = AssertAssignable<
  NormalizedWorkItemLink,
  z.infer<typeof normalizedWorkItemLinkSchema>
>;
type _WorkItemMatchesSchema = AssertAssignable<
  NormalizedWorkItem,
  z.infer<typeof normalizedWorkItemSchema>
>;
