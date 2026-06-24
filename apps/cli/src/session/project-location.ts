import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pc from 'picocolors';
import { isCommandOnPath } from '@excalibur/agent-runtime';
import type { CliDeps } from '../deps';
import type { SelectKeymap } from '../lib/keymap';

/**
 * Smart project-location resolution for the interactive shell.
 *
 * Excalibur is normally run inside a project, but a user might launch it from
 * their home directory (or `/`) precisely because they want to START a new
 * project. Without this, the onboarding would scaffold `.excalibur/` + AGENTS.md
 * straight into `~`. So before analyzing/onboarding, we classify the cwd and —
 * with the LEAST friction (only ask when it's genuinely unclear) — either use it
 * or create a fresh project dir (`mkdir` + `git init` + `chdir`) and continue
 * there. Decision matrix:
 *   - existing project (a marker file present) → use cwd, no prompt
 *   - empty non-root folder → use cwd (it IS the project), no prompt
 *   - a ROOT (home `~` or the filesystem root) → force creating a new project
 *     (only the name is asked — using `~`/`/` as a project is never right)
 *   - non-root with files but no markers (ambiguous) → the only real prompt:
 *     two simple options, Create a new project / Use this directory
 */

/** Files/dirs whose presence means "this is already a project root". */
const PROJECT_MARKERS = new Set<string>([
  '.git',
  '.excalibur',
  '.hg',
  '.svn',
  'package.json',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'go.sum',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
  'deno.json',
  'deno.jsonc',
  'tsconfig.json',
  'Makefile',
  'CMakeLists.txt',
]);

/** Entries that don't count toward "the folder has content". */
const IGNORABLE = new Set<string>(['.DS_Store', 'Thumbs.db', '.localized']);

export type LocationKind = 'project' | 'empty' | 'root' | 'ambiguous';

/**
 * Pure classifier (testable without a TTY): given the cwd, the home dir, and the
 * directory's entry names, decide how to treat the location. `root` takes
 * precedence — `~` and the filesystem root are never a project, even if they
 * happen to contain a marker (e.g. a dotfiles repo in `~`).
 */
export function classifyLocation(input: {
  cwd: string;
  homeDir: string;
  entries: readonly string[];
}): LocationKind {
  const { cwd, homeDir, entries } = input;
  if (cwd === homeDir || dirname(cwd) === cwd) {
    return 'root';
  }
  if (entries.some((entry) => PROJECT_MARKERS.has(entry))) {
    return 'project';
  }
  const meaningful = entries.filter((entry) => !IGNORABLE.has(entry));
  return meaningful.length === 0 ? 'empty' : 'ambiguous';
}

export type NameError = 'empty' | 'separators' | 'reserved';

/**
 * Validates a new project folder name (pure). Rejects empty names, path
 * separators / `..` (so we only ever create a child of the cwd), and
 * dot-leading/hidden names. Returns the error reason, or null when valid.
 */
export function validateProjectName(name: string): NameError | null {
  if (name.length === 0) {
    return 'empty';
  }
  if (/[/\\]/.test(name) || name.includes('..')) {
    return 'separators';
  }
  if (name.startsWith('.')) {
    return 'reserved';
  }
  return null;
}

/**
 * Creates `<parentDir>/<name>` (must not already exist) and runs `git init`
 * inside it when git is available (best-effort — a fresh project wants version
 * control, but a missing/!failing git never blocks creation). Does NOT chdir —
 * the orchestrator does, keeping this unit pure/testable. Returns the abs path.
 */
export function createProjectDir(parentDir: string, name: string, env: NodeJS.ProcessEnv): string {
  const root = join(parentDir, name);
  if (existsSync(root)) {
    throw new Error(`Path already exists: ${root}`);
  }
  mkdirSync(root, { recursive: false });
  if (isCommandOnPath('git', env)) {
    try {
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    } catch {
      // best-effort: a failed `git init` never blocks project creation
    }
  }
  return root;
}

/** Prompts for a valid, non-existing project name (loops until valid). */
async function askProjectName(deps: CliDeps, parentDir: string): Promise<string> {
  for (;;) {
    const raw = (
      await deps.ui.ask(deps.t('project-location.ask-name'), { defaultAnswer: 'my-project' })
    ).trim();
    const error = validateProjectName(raw);
    if (error !== null) {
      deps.ui.warn(deps.t(`project-location.name-${error}`));
      continue;
    }
    if (existsSync(join(parentDir, raw))) {
      deps.ui.warn(deps.t('project-location.name-exists', { name: raw }));
      continue;
    }
    return raw;
  }
}

/** Asks the name, creates the dir (+ git init), chdir's in, and returns it. */
async function createNew(deps: CliDeps, parentDir: string): Promise<string> {
  const name = await askProjectName(deps, parentDir);
  const root = createProjectDir(parentDir, name, deps.env);
  process.chdir(root);
  deps.ui.success(deps.t('project-location.created', { name, path: root }));
  return root;
}

/**
 * Resolves the effective project root for an interactive session, per the matrix
 * above. May create a new directory and `process.chdir` into it; returns the
 * (possibly new) absolute root. Callers must only invoke this on an interactive
 * TTY — a non-interactive run keeps the cwd unchanged.
 */
export async function resolveProjectRoot(
  deps: CliDeps,
  cwd: string,
  keymap?: SelectKeymap,
): Promise<string> {
  let entries: string[];
  try {
    entries = readdirSync(cwd);
  } catch {
    return cwd; // unreadable cwd — treat as the project, never try to create
  }
  const kind = classifyLocation({ cwd, homeDir: deps.homeDir(), entries });
  switch (kind) {
    case 'project':
      return cwd;
    case 'empty':
      deps.ui.info(deps.t('project-location.empty-folder'));
      return cwd;
    case 'root':
      deps.ui.write();
      deps.ui.heading(`${pc.blueBright('⚔')}  ${deps.t('project-location.root-title')}`);
      deps.ui.info(deps.t('project-location.root-intro', { cwd }));
      return createNew(deps, cwd);
    case 'ambiguous': {
      const index = await deps.ui.select(
        deps.t('project-location.ambiguous-q', { cwd }),
        [
          {
            label: deps.t('project-location.opt-create'),
            hint: deps.t('project-location.opt-create-hint'),
          },
          {
            label: deps.t('project-location.opt-here'),
            hint: deps.t('project-location.opt-here-hint'),
          },
        ],
        {
          defaultIndex: 0,
          navHint: deps.t('common.select_hint'),
          ...(keymap !== undefined ? { keymap } : {}),
        },
      );
      return index === 0 ? createNew(deps, cwd) : cwd;
    }
  }
}
