import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';

/**
 * Per-edit formatters (P1.9). After the agent writes/edits a file, the native
 * loop runs the file's formatter (prettier / gofmt / rustfmt / black) so the
 * working tree stays consistently formatted — but ONLY when the formatter is
 * actually available (prettier in the repo's `node_modules/.bin`, the others on
 * PATH). No formatter found → a no-op. Never network-installs anything.
 */

const execFileAsync = promisify(execFile);

interface FormatterSpec {
  /** Binary name. */
  bin: string;
  /** Args to write-format the given (absolute) file in place. */
  args: (file: string) => string[];
  /** Resolve from the repo's `node_modules/.bin` (prettier) vs the system PATH. */
  local: boolean;
}

const PRETTIER: FormatterSpec = { bin: 'prettier', args: (f) => ['--write', f], local: true };

/** File extension → formatter. */
const FORMATTERS: Readonly<Record<string, FormatterSpec>> = {
  '.ts': PRETTIER,
  '.tsx': PRETTIER,
  '.js': PRETTIER,
  '.jsx': PRETTIER,
  '.mjs': PRETTIER,
  '.cjs': PRETTIER,
  '.json': PRETTIER,
  '.css': PRETTIER,
  '.scss': PRETTIER,
  '.less': PRETTIER,
  '.html': PRETTIER,
  '.vue': PRETTIER,
  '.md': PRETTIER,
  '.markdown': PRETTIER,
  '.yaml': PRETTIER,
  '.yml': PRETTIER,
  '.go': { bin: 'gofmt', args: (f) => ['-w', f], local: false },
  '.rs': { bin: 'rustfmt', args: (f) => [f], local: false },
  '.py': { bin: 'black', args: (f) => ['-q', f], local: false },
};

/** Resolves a formatter binary to an executable path, or null if unavailable. */
export type ResolveBin = (spec: FormatterSpec, workdir: string) => string | null;

function defaultResolveBin(spec: FormatterSpec, workdir: string): string | null {
  if (spec.local) {
    const local = join(workdir, 'node_modules', '.bin', spec.bin);
    return existsSync(local) ? local : null;
  }
  // System PATH lookup (no network, no install).
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [spec.bin], {
    encoding: 'utf8',
  });
  return probe.status === 0 ? spec.bin : null;
}

/** The outcome of a format attempt. */
export interface FormatResult {
  formatted: boolean;
  formatter?: string;
}

/** Options for {@link formatFile} (injectable for tests). */
export interface FormatFileOptions {
  workdir: string;
  resolveBin?: ResolveBin;
  exec?: (bin: string, args: string[], cwd: string) => Promise<void>;
}

/**
 * Formats one file in place with its language formatter, if available. Best
 * effort: an unknown extension or a missing/failing formatter is a silent no-op.
 */
export async function formatFile(
  absFile: string,
  options: FormatFileOptions,
): Promise<FormatResult> {
  const spec = FORMATTERS[extname(absFile).toLowerCase()];
  if (spec === undefined) {
    return { formatted: false };
  }
  const resolveBin = options.resolveBin ?? defaultResolveBin;
  const bin = resolveBin(spec, options.workdir);
  if (bin === null) {
    return { formatted: false };
  }
  const exec =
    options.exec ??
    (async (b: string, args: string[], cwd: string): Promise<void> => {
      await execFileAsync(b, args, { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    });
  try {
    await exec(bin, spec.args(absFile), options.workdir);
    return { formatted: true, formatter: spec.bin };
  } catch {
    // A formatter that errors (e.g. a syntax error in the file) never fails the run.
    return { formatted: false, formatter: spec.bin };
  }
}

/** Whether any formatter is registered for a path's extension (no availability check). */
export function hasFormatterFor(file: string): boolean {
  return FORMATTERS[extname(file).toLowerCase()] !== undefined;
}
