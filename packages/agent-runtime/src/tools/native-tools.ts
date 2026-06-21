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

export const NATIVE_TOOLS: ReadonlyArray<NativeToolDefinition> = [
  {
    name: 'read_file',
    description:
      'Read the contents of a file in the repository. Reads are subject to blocked-path rules (e.g. .env, key material).',
    parameters: z.object({ path: relativePathSchema }).strict(),
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
      'List files under a directory, optionally filtered by a glob pattern. Defaults to the repository root.',
    parameters: z
      .object({
        path: z
          .string()
          .min(1)
          .optional()
          .describe('Repository-relative directory to list (defaults to the root)'),
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
];

/** Looks up a native tool definition by name. */
export function getNativeTool(name: string): NativeToolDefinition | undefined {
  return NATIVE_TOOLS.find((tool) => tool.name === name);
}

/** Type guard for the pinned native tool names. */
export function isNativeToolName(value: unknown): value is NativeToolName {
  return typeof value === 'string' && (NATIVE_TOOL_NAMES as readonly string[]).includes(value);
}
