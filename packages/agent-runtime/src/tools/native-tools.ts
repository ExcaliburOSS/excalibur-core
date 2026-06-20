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
];

/** Looks up a native tool definition by name. */
export function getNativeTool(name: string): NativeToolDefinition | undefined {
  return NATIVE_TOOLS.find((tool) => tool.name === name);
}

/** Type guard for the pinned native tool names. */
export function isNativeToolName(value: unknown): value is NativeToolName {
  return typeof value === 'string' && (NATIVE_TOOL_NAMES as readonly string[]).includes(value);
}
