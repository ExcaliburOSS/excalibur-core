import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  agentRoleSchema,
  permissionsSectionSchema,
  type AgentRole,
  type ExcaliburConfig,
} from '@excalibur/shared';
import { z } from 'zod';

/**
 * Self-contained custom agents (P1.7).
 *
 * A single markdown file `<name>.md` under `.excalibur/agents/` (project) or
 * `~/.config/excalibur/agents/` (user-global) fully defines a selectable agent:
 * its persona (the markdown body becomes the system prompt), its model and
 * temperature, the role it acts as, the subset of native tools it may use, and
 * its own permission overrides. YAML front matter carries the structured fields;
 * the body is the prompt.
 *
 * ```markdown
 * ---
 * name: Security Reviewer
 * description: Adversarial security review, read-only
 * role: security
 * model: kimi-k2.7-code        # a model id (forwarded as `model`)
 * provider: kimi               # a providers.yaml key (forwarded as `provider`)
 * temperature: 0.1
 * tools: [read_file, search_code, git_diff, web_search]   # allowlist (narrows the role)
 * permissions:
 *   tools: { write_file: false, run_command: false }
 *   deniedCommands: ['git push*']
 * ---
 *
 * You are a meticulous security reviewer. Hunt for injection, secret handling,
 * auth and unsafe shell/network. Refute the work; never rubber-stamp.
 * ```
 *
 * Project agents override user-global ones on a name clash. This mirrors the
 * custom-commands loader (P1.6) — same discovery dirs, same front-matter split.
 */

/** Permission overrides an agent may carry (the `permissions:` config shape). */
export type AgentPermissions = NonNullable<ExcaliburConfig['permissions']>;

/** One loaded custom agent. */
export interface CustomAgent {
  /** Lowercase agent name (the file basename without `.md`); the selection key. */
  name: string;
  /** Display name (front-matter `name`, else the humanized file name). */
  displayName: string;
  /** One-line description (front-matter `description`, else first body line). */
  description: string;
  /** The markdown body — used verbatim as the agent's system prompt. */
  systemPrompt: string;
  /** Role the agent acts as in the loop (drives the read-only tool floor). */
  role?: AgentRole;
  /** Model id, forwarded to the gateway as `model`. */
  model?: string;
  /** Provider name (a providers.yaml key), forwarded as `provider`. */
  provider?: string;
  /** Sampling temperature, forwarded to the model (omitted → provider default). */
  temperature?: number;
  /**
   * Native tool allowlist. NARROWS the role's tool set (it can never grant a
   * read-only role mutating tools — the role floor is intersected, deny wins).
   */
  tools?: string[];
  /** Per-agent permission overrides, merged over the project permissions. */
  permissions?: AgentPermissions;
  /** Where it came from (project overrides global). */
  source: 'project' | 'global';
  /** Absolute path to the source file. */
  path: string;
}

/** Front-matter schema (everything optional; the body carries the prompt). */
const agentFrontMatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    role: agentRoleSchema.optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    tools: z.array(z.string()).optional(),
    permissions: permissionsSectionSchema.optional(),
  })
  .passthrough();

type AgentFrontMatter = z.infer<typeof agentFrontMatterSchema>;

/** Splits optional `---` YAML front matter from the markdown body. */
function splitFrontMatter(content: string): { meta: unknown; body: string } {
  const normalized = content.replace(/^\uFEFF/, '');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (match !== null) {
    let meta: unknown = null;
    try {
      meta = parseYaml(match[1] as string);
    } catch {
      meta = null; // malformed front matter → no metadata
    }
    return { meta, body: (match[2] ?? '').trim() };
  }
  return { meta: null, body: normalized.trim() };
}

function firstLine(body: string): string {
  const line = body.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line
    .replace(/^#+\s*/, '')
    .trim()
    .slice(0, 120);
}

function humanize(name: string): string {
  return name
    .split(/[-_]/)
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

/**
 * Parses one agent file's content into a {@link CustomAgent} (minus source/path).
 * Returns `null` when the body is empty (an agent with no prompt is useless) or
 * front matter is present but invalid (so a typo'd schema fails loudly upstream
 * rather than silently running with wrong permissions).
 */
export function parseAgentFile(
  name: string,
  content: string,
): Omit<CustomAgent, 'source' | 'path'> | null {
  const { meta, body } = splitFrontMatter(content);
  if (body.length === 0) {
    return null;
  }
  let fm: AgentFrontMatter = {};
  if (meta !== null && typeof meta === 'object') {
    const parsed = agentFrontMatterSchema.safeParse(meta);
    if (!parsed.success) {
      return null; // invalid front matter — refuse rather than misconfigure
    }
    fm = parsed.data;
  }
  const description =
    fm.description !== undefined && fm.description.trim().length > 0
      ? fm.description.trim()
      : firstLine(body);
  return {
    name,
    displayName:
      fm.name !== undefined && fm.name.trim().length > 0 ? fm.name.trim() : humanize(name),
    description,
    systemPrompt: body,
    ...(fm.role !== undefined ? { role: fm.role } : {}),
    ...(fm.model !== undefined ? { model: fm.model } : {}),
    ...(fm.provider !== undefined ? { provider: fm.provider } : {}),
    ...(fm.temperature !== undefined ? { temperature: fm.temperature } : {}),
    ...(fm.tools !== undefined ? { tools: fm.tools } : {}),
    ...(fm.permissions !== undefined ? { permissions: fm.permissions } : {}),
  };
}

function scanDir(dir: string, source: 'project' | 'global', into: Map<string, CustomAgent>): void {
  if (!existsSync(dir)) {
    return;
  }
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /\.md$/i.test(f));
  } catch {
    return;
  }
  for (const file of files) {
    const name = basename(file, '.md').toLowerCase();
    if (name.length === 0) continue;
    try {
      const parsed = parseAgentFile(name, readFileSync(join(dir, file), 'utf8'));
      if (parsed !== null) {
        into.set(name, { ...parsed, source, path: join(dir, file) });
      }
    } catch {
      /* skip an unreadable agent file */
    }
  }
}

/** Options for {@link loadCustomAgents}. */
export interface LoadCustomAgentsOptions {
  repoRoot: string;
  /** Home dir for the user-global `~/.config/excalibur/agents/` scan. */
  homeDir?: string;
  /** Include the user-global scan (off by default for hermetic behavior). */
  includeGlobal?: boolean;
}

/**
 * Loads custom agents from the project dir (and optionally the user-global dir).
 * Project agents override user-global ones on a name clash.
 */
export function loadCustomAgents(options: LoadCustomAgentsOptions): Map<string, CustomAgent> {
  const agents = new Map<string, CustomAgent>();
  // Global first so project entries override on a name collision.
  if (options.includeGlobal === true && options.homeDir !== undefined) {
    scanDir(join(options.homeDir, '.config', 'excalibur', 'agents'), 'global', agents);
  }
  scanDir(join(options.repoRoot, '.excalibur', 'agents'), 'project', agents);
  return agents;
}

/** Resolves a single agent by name (project then global), or null if absent. */
export function resolveCustomAgent(
  name: string,
  options: LoadCustomAgentsOptions,
): CustomAgent | null {
  return loadCustomAgents({ ...options, includeGlobal: true }).get(name.toLowerCase()) ?? null;
}
