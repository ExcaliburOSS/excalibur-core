import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SWARM_MAX_TOTAL_AGENTS, topologicalWaves, type JsonSchema } from '@excalibur/core';
import { agentRoleSchema, type AgentRole } from '@excalibur/shared';
import { CliUsageError } from '../errors';
import type { SwarmSubtask } from './swarm';

/**
 * AO5-4 — AUTHOR-defined orchestration. A user commits a spec of NAMED agent
 * steps (id · instruction · dependsOn · role?) that COMPILES to {@link SwarmSubtask}[]
 * and runs through the EXISTING staged executor (`runSwarmFlow`) — the last bit of
 * Claude-Code Workflow-tool parity, WITHOUT forcing hand-authored DAGs as the
 * default (auto-orchestration stays the default; this is an explicit escape hatch).
 *
 * Unlike the LLM `decomposeTask` path, an author file is held to a STRICT
 * contract: ids are sanitized + unique, every `dependsOn` must reference a real
 * step (a typo is an error, not silently ignored), and a dependency CYCLE is a
 * hard failure (the auto path silently flattens a cycle to one wave).
 */

/** One authored step (compiles 1:1 to a SwarmSubtask; the id IS the name). */
export interface AuthoredStep {
  id: string;
  instruction: string;
  dependsOn?: string[];
  role?: AgentRole;
  title?: string;
  /** AO7-4 — JSON-schema contract for this step's output (validated + retried). */
  outputSchema?: JsonSchema;
}

export interface AuthoredOrchestration {
  version?: 1;
  task?: string;
  steps: AuthoredStep[];
}

const STEP_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Compiles a parsed author spec into a task + SwarmSubtask[] (pure). Throws a
 * {@link CliUsageError} (→ a clean CLI message, exit 2) on any contract
 * violation: empty/missing/duplicate/unsafe id, missing instruction, a
 * `dependsOn` that names an unknown or self step, an invalid `role`, or a cycle.
 */
export function compileAuthoredOrchestration(raw: unknown): {
  task: string;
  subtasks: SwarmSubtask[];
} {
  if (typeof raw !== 'object' || raw === null) {
    throw new CliUsageError('orchestration spec must be a YAML mapping with a "steps" list');
  }
  const spec = raw as Record<string, unknown>;
  const rawSteps = Array.isArray(spec['steps']) ? (spec['steps'] as unknown[]) : null;
  if (rawSteps === null || rawSteps.length === 0) {
    throw new CliUsageError('orchestration spec needs a non-empty "steps" list');
  }
  // Strict contract + safety: cap the step count BEFORE the O(n^2) toposort below,
  // so an over-large spec fails fast with a clear error rather than being silently
  // truncated to the swarm's agent ceiling (or hanging the CLI on a huge DAG).
  if (rawSteps.length > SWARM_MAX_TOTAL_AGENTS) {
    throw new CliUsageError(
      `orchestration spec has too many steps (${rawSteps.length}); the swarm runs at most ${SWARM_MAX_TOTAL_AGENTS} lanes — split it or reduce steps`,
    );
  }
  const ids = new Set<string>();
  const subtasks: SwarmSubtask[] = rawSteps.map((entry, i): SwarmSubtask => {
    if (typeof entry !== 'object' || entry === null) {
      throw new CliUsageError(`step ${i + 1} must be a mapping with an id + instruction`);
    }
    const e = entry as Record<string, unknown>;
    // A present-but-wrong-type id is an ERROR with a clear message (not the
    // misleading "missing an id" you'd get from collapsing it to '').
    if (e['id'] !== undefined && typeof e['id'] !== 'string') {
      throw new CliUsageError(`step ${i + 1} id must be a string — quote it, e.g. "123"`);
    }
    const id = typeof e['id'] === 'string' ? e['id'].trim() : '';
    if (id.length === 0) throw new CliUsageError(`step ${i + 1} is missing an "id"`);
    if (!STEP_ID.test(id)) {
      throw new CliUsageError(`step "${id}" has an invalid id — use letters, digits, "_" or "-"`);
    }
    if (ids.has(id)) throw new CliUsageError(`duplicate step id "${id}"`);
    ids.add(id);
    if (e['instruction'] !== undefined && typeof e['instruction'] !== 'string') {
      throw new CliUsageError(`step "${id}" instruction must be a string`);
    }
    const instruction = typeof e['instruction'] === 'string' ? e['instruction'].trim() : '';
    if (instruction.length === 0)
      throw new CliUsageError(`step "${id}" is missing an "instruction"`);
    // A non-list dependsOn (e.g. a bare `dependsOn: base`) would otherwise be
    // SILENTLY dropped → the step mis-schedules into wave 0. Reject it (strict
    // contract: a typo is an error, not a wrong schedule).
    if (e['dependsOn'] !== undefined && !Array.isArray(e['dependsOn'])) {
      throw new CliUsageError(
        `step "${id}" has a non-list "dependsOn" — use a YAML list, e.g. [base]`,
      );
    }
    const dependsOn = Array.isArray(e['dependsOn'])
      ? (e['dependsOn'] as unknown[]).map((d) => String(d).trim()).filter((d) => d.length > 0)
      : [];
    let role: AgentRole | undefined;
    if (e['role'] !== undefined) {
      const parsed = agentRoleSchema.safeParse(e['role']);
      if (!parsed.success) {
        throw new CliUsageError(`step "${id}" has an invalid role "${String(e['role'])}"`);
      }
      role = parsed.data;
    }
    // AO7-4 — optional output schema (a YAML mapping → JsonSchema). A present-but-
    // non-mapping value is a contract violation (an author typo), not silently dropped.
    if (
      e['outputSchema'] !== undefined &&
      (typeof e['outputSchema'] !== 'object' || e['outputSchema'] === null)
    ) {
      throw new CliUsageError(
        `step "${id}" has a non-mapping "outputSchema" — use a JSON-schema object`,
      );
    }
    const outputSchema = e['outputSchema'] as JsonSchema | undefined;
    const title =
      typeof e['title'] === 'string' && e['title'].trim().length > 0
        ? e['title'].trim()
        : instruction.slice(0, 60);
    return {
      id,
      title,
      instruction,
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(outputSchema !== undefined ? { outputSchema } : {}),
    };
  });

  // Validate dependency references — an author typo is an ERROR, not a silent drop.
  for (const s of subtasks) {
    for (const dep of s.dependsOn ?? []) {
      if (dep === s.id) throw new CliUsageError(`step "${s.id}" depends on itself`);
      if (!ids.has(dep)) {
        throw new CliUsageError(`step "${s.id}" depends on unknown step "${dep}"`);
      }
    }
  }
  // HARD-reject a cycle (the auto path silently flattens; an author wants an error).
  if (topologicalWaves(subtasks) === null) {
    throw new CliUsageError(
      'orchestration spec has a dependency CYCLE — break the loop in dependsOn',
    );
  }

  const task =
    typeof spec['task'] === 'string' && spec['task'].trim().length > 0
      ? spec['task'].trim()
      : subtasks.map((s) => s.title).join('; ');
  return { task, subtasks };
}

/**
 * Resolves a `nameOrPath` to the author spec file: a bare name → the convention
 * `.excalibur/orchestrations/<name>.yaml`; anything that looks like a path (has a
 * separator or a `.yaml`/`.yml` extension) → a RELATIVE path is resolved against
 * the repo root, an ABSOLUTE path is used as-is. Note: a relative `../…` or an
 * absolute path MAY resolve outside the repository — this is an operator-supplied
 * local CLI argument (the operator already has shell access), not untrusted input,
 * so the path is intentionally not confined to the repo.
 */
export function resolveAuthoredSpecPath(repoRoot: string, nameOrPath: string): string {
  const looksLikePath = nameOrPath.includes('/') || /\.ya?ml$/i.test(nameOrPath);
  if (looksLikePath) {
    return isAbsolute(nameOrPath) ? nameOrPath : resolve(repoRoot, nameOrPath);
  }
  return join(repoRoot, '.excalibur', 'orchestrations', `${nameOrPath}.yaml`);
}

/**
 * Reads + parses + compiles an author orchestration spec (I/O entry). Throws a
 * {@link CliUsageError} on a missing/unreadable/unparseable file or any contract
 * violation (delegated to {@link compileAuthoredOrchestration}).
 */
export function loadAuthoredOrchestration(
  repoRoot: string,
  nameOrPath: string,
): { task: string; subtasks: SwarmSubtask[]; path: string } {
  const path = resolveAuthoredSpecPath(repoRoot, nameOrPath);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new CliUsageError(`orchestration spec not found: ${path}`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new CliUsageError(
      `could not parse orchestration spec ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { ...compileAuthoredOrchestration(raw), path };
}
