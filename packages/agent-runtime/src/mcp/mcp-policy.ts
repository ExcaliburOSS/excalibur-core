import type { AgentRole } from '@excalibur/shared';
import type { McpTool } from './mcp-client';

/**
 * MCP tool access policy (F6). Decides whether a server tool is READ-ONLY or
 * MUTATING (so read-only/research roles only ever receive non-mutating tools)
 * and whether a given role may use it. Pure — the adapter applies the decision.
 *
 * Classification precedence: explicit config (`readOnlyTools`/`mutatingTools`)
 * overrides the server's own `annotations` (`readOnlyHint`/`destructiveHint`).
 * When NOTHING declares the tool, it is treated as MUTATING — the safe default
 * (a read-only role never gets an unclassified, possibly side-effecting tool).
 */

export type McpToolAccess = 'read' | 'mutate';

export interface McpToolClassConfig {
  readOnlyTools?: ReadonlyArray<string>;
  mutatingTools?: ReadonlyArray<string>;
}

/** Classifies one MCP tool as read-only or mutating (config overrides hints). */
export function toolAccessFor(tool: McpTool, cfg: McpToolClassConfig = {}): McpToolAccess {
  if (cfg.mutatingTools?.includes(tool.name) === true) return 'mutate';
  if (cfg.readOnlyTools?.includes(tool.name) === true) return 'read';
  if (tool.annotations?.destructiveHint === true) return 'mutate';
  if (tool.annotations?.readOnlyHint === true) return 'read';
  // Unclassified → assume it can mutate (safe default for read-only roles).
  return 'mutate';
}

/**
 * Whether a tool of the given access level may be EXPOSED to a role. A read-only
 * role (planner/reviewer/research) only ever sees `read` tools; acting roles see
 * everything. `allowReadOnlyRoles=false` hides the server from read-only roles
 * entirely.
 */
export function allowedForRole(
  access: McpToolAccess,
  isReadOnlyRole: boolean,
  allowReadOnlyRoles: boolean,
): boolean {
  if (!isReadOnlyRole) return true;
  if (!allowReadOnlyRoles) return false;
  return access === 'read';
}

/** The canonical read-only Excalibur roles (kept in sync with the adapter). */
export const READ_ONLY_AGENT_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>([
  'planner',
  'architect',
  'reviewer',
  'security',
  'discovery_reviewer',
  'ux_reviewer',
  'growth_reviewer',
  'scope_guardian',
  'product_strategist',
  'customer_researcher',
]);
