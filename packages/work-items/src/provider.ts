import { z } from 'zod';
import type { NormalizedWorkItem, WorkItemProviderType } from './types';

/**
 * Provider I/O types and the provider abstraction
 * (docs/spec/work-items-core.md §1, §3).
 */

export const getWorkItemInputSchema = z.object({
  integrationId: z.string(),
  externalIdOrKey: z.string(),
});
export type GetWorkItemInput = z.infer<typeof getWorkItemInputSchema>;

export const listWorkItemsInputSchema = z.object({
  integrationId: z.string(),
  query: z.string().optional(),
  status: z.string().optional(),
  assignee: z.string().optional(),
  project: z.string().optional(),
  team: z.string().optional(),
  labels: z.array(z.string()).optional(),
  limit: z.number().int().min(1).optional(),
});
export type ListWorkItemsInput = z.infer<typeof listWorkItemsInputSchema>;

export const addWorkItemCommentInputSchema = z.object({
  integrationId: z.string(),
  externalIdOrKey: z.string(),
  body: z.string(),
});
export type AddWorkItemCommentInput = z.infer<typeof addWorkItemCommentInputSchema>;

export const updateWorkItemStatusInputSchema = z.object({
  integrationId: z.string(),
  externalIdOrKey: z.string(),
  status: z.string(),
});
export type UpdateWorkItemStatusInput = z.infer<typeof updateWorkItemStatusInputSchema>;

export const linkPullRequestInputSchema = z.object({
  integrationId: z.string(),
  externalIdOrKey: z.string(),
  pullRequest: z.object({
    provider: z.enum(['github', 'gitlab', 'bitbucket']),
    url: z.string(),
    title: z.string(),
    number: z.number().int().optional(),
    repositoryFullName: z.string().optional(),
  }),
});
export type LinkPullRequestInput = z.infer<typeof linkPullRequestInputSchema>;

/**
 * Normalized work item provider abstraction. OSS local integrations and
 * Enterprise app integrations share this interface even though authentication
 * and sync differ. Real HTTP providers arrive in later milestones; M1 ships
 * the deterministic `MockWorkItemProvider`.
 */
export interface WorkItemProvider {
  type: WorkItemProviderType;
  getWorkItem(input: GetWorkItemInput): Promise<NormalizedWorkItem>;
  listWorkItems(input: ListWorkItemsInput): Promise<NormalizedWorkItem[]>;
  addComment(input: AddWorkItemCommentInput): Promise<void>;
  updateStatus(input: UpdateWorkItemStatusInput): Promise<void>;
  linkPullRequest(input: LinkPullRequestInput): Promise<void>;
  validateCredentials(): Promise<boolean>;
}
