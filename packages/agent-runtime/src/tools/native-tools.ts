import { z } from 'zod';

/**
 * Native agent tool catalog (Build Contract §4.4, OSS spec §15).
 *
 * The native adapter exposes exactly this set of tools. Each tool declares a
 * zod schema for its parameters so tool calls can be validated before the
 * permission engine and the real tool implementations run.
 */

export const NATIVE_TOOL_NAMES = [
  'read_file',
  'write_file',
  'edit',
  'list_files',
  'search_code',
  'run_command',
  'git_diff',
  'apply_patch',
  'create_branch',
  'run_tests',
  'update_tasks',
  'web_fetch',
  'web_search',
  'web_extract',
  'web_crawl',
  'research',
  'lsp',
  'question',
  'skill',
  // Management/awareness tools (proactive foundation): the agent pulls Excalibur's
  // own project state into its reasoning mid-conversation. Read-only; backed by
  // host-injected `ManagementToolset` callbacks (the CLI owns the stores).
  'project_status',
  'work_items',
  'sprint_status',
  'plans',
  'insights',
  'run_logs',
  'list_agents',
  'list_skills',
  'sessions',
  'verify',
  'review',
] as const;
export type NativeToolName = (typeof NATIVE_TOOL_NAMES)[number];

export interface NativeToolDefinition {
  name: NativeToolName;
  description: string;
  parameters: z.ZodTypeAny;
}

const relativePathSchema = z
  .string()
  .min(1, 'path must not be empty')
  .describe('Repository-relative file path');

// Reads may leave the working directory: an absolute path or a `../sibling/…`
// path is accepted (the user often points the agent at another project).
const readablePathSchema = z
  .string()
  .min(1, 'path must not be empty')
  .describe('File path — repository-relative, absolute, or ../ into a sibling directory');

export const NATIVE_TOOLS: ReadonlyArray<NativeToolDefinition> = [
  {
    name: 'read_file',
    description:
      'Read the contents of any file. The path may be repository-relative, an absolute path, or a `../sibling/…` path — reads are NOT confined to the working directory, so you can review a sibling project or any file the user points you at. Only secret files (.env, keys, credentials) are refused.',
    parameters: z.object({ path: readablePathSchema }).strict(),
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite a file in the repository with the given content. Requires write permission for the path.',
    parameters: z
      .object({
        path: relativePathSchema,
        content: z.string().describe('Full new file content'),
      })
      .strict(),
  },
  {
    name: 'edit',
    description:
      'Make a surgical edit to an EXISTING file: replace an exact substring (oldString) with newString — far cheaper than rewriting the whole file. oldString must match exactly (including whitespace/indentation) and be UNIQUE in the file unless replaceAll is set. Use write_file to create a new file.',
    parameters: z
      .object({
        path: relativePathSchema,
        oldString: z
          .string()
          .min(1)
          .describe('Exact text to replace (must be unique unless replaceAll)'),
        newString: z.string().describe('Replacement text'),
        replaceAll: z
          .boolean()
          .optional()
          .describe('Replace every occurrence (default false → oldString must be unique)'),
      })
      .strict(),
  },
  {
    name: 'list_files',
    description:
      'List files under a directory, optionally filtered by a glob pattern. Defaults to the repository root. The path may be repository-relative, absolute, or `../` into a sibling directory (listing is not confined to the working directory).',
    parameters: z
      .object({
        path: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Directory to list — repository-relative, absolute, or ../ into a sibling (defaults to the root)',
          ),
        glob: z.string().min(1).optional().describe('Optional glob filter, e.g. "src/**/*.ts"'),
      })
      .strict(),
  },
  {
    name: 'search_code',
    description:
      'Search the repository for a string or regular expression and return matching locations.',
    parameters: z
      .object({
        query: z.string().min(1, 'query must not be empty').describe('Search text or regex'),
        glob: z.string().min(1).optional().describe('Optional glob restricting the search scope'),
        maxResults: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum number of matches to return'),
      })
      .strict(),
  },
  {
    name: 'run_command',
    description:
      'Run a shell command in the working directory. Commands outside the allowlist require confirmation.',
    parameters: z
      .object({
        command: z.string().min(1, 'command must not be empty').describe('Command line to execute'),
        cwd: z
          .string()
          .min(1)
          .optional()
          .describe('Repository-relative working directory (defaults to the repo root)'),
      })
      .strict(),
  },
  {
    name: 'git_diff',
    description:
      'Show the current git diff of the working tree, optionally limited to specific paths or the staged index.',
    parameters: z
      .object({
        paths: z.array(relativePathSchema).optional().describe('Limit the diff to these paths'),
        staged: z
          .boolean()
          .optional()
          .describe('Diff the staged index instead of the working tree'),
      })
      .strict(),
  },
  {
    name: 'apply_patch',
    description:
      'Apply a unified diff to the working tree. Requires confirmation under the standard-safe preset.',
    parameters: z
      .object({
        diff: z.string().min(1, 'diff must not be empty').describe('Unified diff to apply'),
      })
      .strict(),
  },
  {
    name: 'create_branch',
    description: 'Create (and switch to) a new git branch for isolated agent work.',
    parameters: z
      .object({
        name: z
          .string()
          .min(1, 'branch name must not be empty')
          .regex(/^\S+$/, 'branch name must not contain whitespace')
          .describe('Branch name, e.g. "excalibur/fix-webhook-retry"'),
      })
      .strict(),
  },
  {
    name: 'run_tests',
    description:
      'Run the project test suite (the detected test command by default), optionally narrowed to a pattern.',
    parameters: z
      .object({
        command: z
          .string()
          .min(1)
          .optional()
          .describe('Override test command (defaults to the detected one from config)'),
        pattern: z.string().min(1).optional().describe('Test name or file pattern to filter by'),
      })
      .strict(),
  },
  {
    name: 'update_tasks',
    description:
      'Maintain a live checklist for the CURRENT request. Pass the FULL list each time (a snapshot that replaces the previous one), with exactly one item "in_progress" and finished ones "completed". It is shown to the user as a live to-do list. Use it for multi-step work to make your plan visible; skip it for trivial one-step tasks. Read-only — it changes nothing on disk.',
    parameters: z
      .object({
        tasks: z
          .array(
            z.object({
              text: z
                .string()
                .min(1)
                .describe('Short imperative step, e.g. "Add a retry guard to the webhook handler"'),
              status: z
                .enum(['pending', 'in_progress', 'completed'])
                .describe('pending | in_progress | completed'),
            }),
          )
          .describe('The full checklist snapshot (replaces any previous one)'),
      })
      .strict(),
  },
  {
    name: 'web_fetch',
    description:
      'Fetch a web page or document by URL and return clean, readable text/markdown (scripts, styles and navigation stripped). Use it to read docs, issues, RFCs, or any page for research. Subject to the network policy and SSRF-protected; results are size-capped and secret-redacted. Returns text only (HTML, PDF, JSON, plain text).',
    parameters: z
      .object({
        url: z.string().url().describe('Absolute http(s) URL to fetch'),
        maxChars: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe('Cap on returned characters (default 50000)'),
      })
      .strict(),
  },
  {
    name: 'web_search',
    description:
      'Search the web and return a ranked list of results (title, URL, snippet). Use it to DISCOVER sources for a question, then web_fetch a result URL to read it in full. Free and unlimited by default (a local SearXNG instance when available, otherwise DuckDuckGo) — no API key required. Subject to the network policy.',
    parameters: z
      .object({
        query: z.string().min(1, 'query must not be empty').describe('Search query'),
        maxResults: z
          .number()
          .int()
          .positive()
          .max(20)
          .optional()
          .describe('Maximum number of results to return (default 8)'),
      })
      .strict(),
  },
  {
    name: 'web_extract',
    description:
      'Extract STRUCTURED data from a web page. Give a URL and a JSON Schema describing the fields you want; returns JSON matching that schema. Reads the page (the local browser when enabled, otherwise clean Tier-1 markdown) and runs one extraction pass. Free by default; SSRF-protected and governed by the network policy.',
    parameters: z
      .object({
        url: z.string().url().describe('Absolute http(s) URL to extract from'),
        schema: z
          .record(z.unknown())
          .describe(
            'JSON-Schema object describing the fields to extract, e.g. {"type":"object","properties":{"price":{"type":"number"}}}',
          ),
        instructions: z
          .string()
          .min(1)
          .optional()
          .describe('Extra natural-language guidance for ambiguous fields'),
        maxChars: z.number().int().positive().max(100_000).optional(),
      })
      .strict(),
  },
  {
    name: 'web_crawl',
    description:
      'Crawl a website from a seed URL and return the readable markdown of the pages found. Bounded by depth and page count, polite (robots.txt + per-host rate limit + on-disk cache), and SSRF-protected per page. Use it to gather a small set of related pages (docs sections, a changelog), not to scrape an entire site. Free by default.',
    parameters: z
      .object({
        url: z.string().url().describe('Seed URL to start crawling'),
        maxDepth: z
          .number()
          .int()
          .min(0)
          .max(3)
          .optional()
          .describe('Link depth from the seed (default 1)'),
        maxPages: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Max pages to fetch (default 10, hard-capped by config.crawl.maxPages)'),
        sameHostOnly: z.boolean().optional().describe('Stay on the seed host (default true)'),
        useSitemap: z
          .boolean()
          .optional()
          .describe('Seed the frontier from /sitemap.xml (default false)'),
      })
      .strict(),
  },
  {
    name: 'research',
    description:
      'Research a question across the web: searches, fetches the top sources, and returns a SOURCED EVIDENCE BUNDLE (each source numbered, hashed and timestamped) for you to synthesize a cited answer. Use it for questions needing current or external information. Free by default; SSRF-protected and governed by the network policy. Cite sources as [n] and flag anything the sources do not support.',
    parameters: z
      .object({
        question: z.string().min(1, 'question must not be empty').describe('The research question'),
        maxSources: z
          .number()
          .int()
          .positive()
          .max(12)
          .optional()
          .describe('Maximum sources to fetch (default 5)'),
      })
      .strict(),
  },
  {
    name: 'lsp',
    description:
      'Ask the language server for code intelligence at a position: "definition" (where a symbol is defined), "references" (everywhere it is used), or "hover" (its type/signature/docs). Pass the repo-relative file plus a 1-based line and column pointing AT the symbol. Use it to navigate real code instead of guessing — e.g. before editing a function, find its definition and all references. Returns null gracefully when no language server is available for the file.',
    parameters: z
      .object({
        path: relativePathSchema,
        line: z.number().int().positive().describe('1-based line of the symbol'),
        column: z.number().int().positive().describe('1-based column of the symbol'),
        query: z
          .enum(['definition', 'references', 'hover'])
          .describe('What to look up at that position'),
      })
      .strict(),
  },
  {
    name: 'question',
    description:
      'Ask the human a single clarifying question when the task is genuinely ambiguous and a wrong assumption would be costly (e.g. which of two files, which API, a missing decision). Returns their answer as text. Use SPARINGLY — prefer acting on reasonable assumptions. If no human is available (autonomous/CI run), it returns a note and you must proceed with your best judgment.',
    parameters: z
      .object({
        question: z.string().min(1, 'question must not be empty').describe('The question to ask'),
        context: z
          .string()
          .optional()
          .describe('Optional one-line context shown with the question (why you are asking)'),
      })
      .strict(),
  },
  {
    name: 'skill',
    description:
      "Load a project SKILL on demand (progressive disclosure). Call with NO name to list the available skills (name + one-line description); call with a name to load that skill's full instructions, then follow them. Skills package reusable, project-specific know-how (deploy steps, conventions, runbooks). Loading a skill is a deliberate pull — only load one when it is clearly relevant to the task.",
    parameters: z
      .object({
        name: z
          .string()
          .optional()
          .describe('Skill name to load; omit to list all available skills'),
      })
      .strict(),
  },
  {
    name: 'project_status',
    description:
      "Read this project's current Excalibur state: counts of runs/patches/interactions, the latest activity, and the work-item board by lane. Read-only. Call it proactively when the user asks where things stand / what's been done / what's next, or before planning, so you ground your answer in the real project state.",
    parameters: z
      .object({
        discovery: z
          .boolean()
          .optional()
          .describe('Also include recent discovery (clarification) sessions'),
      })
      .strict(),
  },
  {
    name: 'work_items',
    description:
      'Browse the work-item backlog (the kanban tasks): list the board, filter by status/query/labels, or fetch one by key (e.g. WI-12). Read-only. Use it proactively to see what is planned, in progress, or blocked before you act, and to reference real task ids when you discuss the plan.',
    parameters: z
      .object({
        status: z
          .string()
          .optional()
          .describe('Filter by status/lane (e.g. todo, in_progress, done, blocked)'),
        query: z.string().optional().describe('Free-text search over title/description'),
        labels: z
          .array(z.string())
          .optional()
          .describe('Filter to items carrying ALL these labels'),
        limit: z.number().int().positive().optional().describe('Max items to return (default 20)'),
        key: z
          .string()
          .optional()
          .describe('Fetch a single work item by its key/id (overrides the filters)'),
      })
      .strict(),
  },
  {
    name: 'sprint_status',
    description:
      'Read the active sprint (or a named one) with its burndown: total vs done story points, item count, and the ideal-vs-remaining trend. Read-only. Use it proactively when the user asks how the sprint/iteration is going or whether work is on track.',
    parameters: z
      .object({
        sprintId: z
          .string()
          .optional()
          .describe('A specific sprint id; omit for the active sprint'),
      })
      .strict(),
  },
  {
    name: 'plans',
    description:
      'List the saved structured plans, or show one by id (its steps and per-step progress). Read-only. Use it proactively to recall an approved plan, check what step work is on, or reference the plan when the user asks about the roadmap. (To CREATE or run a plan, do the work directly — this only reads existing plans.)',
    parameters: z
      .object({
        id: z.string().optional().describe('A plan id to show in detail; omit to list all plans'),
      })
      .strict(),
  },
  {
    name: 'insights',
    description:
      "Aggregate usage insights across this project's runs: totals and per-model/-workflow/-day breakdowns of runs, cost, tokens, files changed and completion rate. Read-only. Use it when the user asks about usage, cost, or productivity trends.",
    parameters: z
      .object({
        sinceDays: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Only include runs from the last N days (omit for all-time)'),
      })
      .strict(),
  },
  {
    name: 'run_logs',
    description:
      'Read the recorded event log of a past run (a specific runId, or the latest) — the phases, tool calls, commands and their outcomes. Read-only. Use it to understand what a previous run actually did or why it failed, before reacting to it.',
    parameters: z
      .object({
        runId: z.string().optional().describe('The run id to inspect; omit for the latest run'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max recent events to summarize (default 40)'),
      })
      .strict(),
  },
  {
    name: 'list_agents',
    description:
      'List the self-contained custom agents defined for this project (`.excalibur/agents/*.md`) with their role/model. Read-only. Rarely needed mid-task — use it only when the user asks which custom agents exist or you must pick one.',
    parameters: z.object({}).strict(),
  },
  {
    name: 'list_skills',
    description:
      'List the project SKILLS known to Excalibur with their trust level and whether they are enabled (the configured-skills view). Read-only. Distinct from the `skill` tool, which LOADS a skill body; use this only to survey what skills exist and their status.',
    parameters: z.object({}).strict(),
  },
  {
    name: 'sessions',
    description:
      'List recent Excalibur sessions (id, title, turn count, model), or show one by id (its transcript summary). Read-only. Rarely needed mid-task — use it only when the user refers back to a past session.',
    parameters: z
      .object({
        id: z
          .string()
          .optional()
          .describe('A session id to summarize; omit to list recent sessions'),
      })
      .strict(),
  },
  {
    name: 'verify',
    description:
      "Get your current working-tree changes framed for SELF-VERIFICATION across Excalibur's adversarial lenses (correctness, security, regression, spec, reproduce). Returns the redacted diff + a checklist; YOU then verify it in this turn and report issues. Read-only (no file changes). Call it proactively to self-check BEFORE declaring a task done, especially for risky or non-trivial edits.",
    parameters: z.object({}).strict(),
  },
  {
    name: 'review',
    description:
      'Get your current working-tree changes framed for a focused SELF-REVIEW (bugs, security, edge cases, missing tests, style). Returns the redacted diff + reviewer guidance; YOU then critique it in this turn. Read-only (no file changes). Use it proactively before finishing, or when the user asks to review the pending changes.',
    parameters: z.object({}).strict(),
  },
];

/** Looks up a native tool definition by name. */
export function getNativeTool(name: string): NativeToolDefinition | undefined {
  return NATIVE_TOOLS.find((tool) => tool.name === name);
}

/** Type guard for the pinned native tool names. */
export function isNativeToolName(value: unknown): value is NativeToolName {
  return typeof value === 'string' && (NATIVE_TOOL_NAMES as readonly string[]).includes(value);
}
