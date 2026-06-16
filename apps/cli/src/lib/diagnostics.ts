import { execSync } from 'node:child_process';
import type { AdditionalContextSource } from '@excalibur/core';

/**
 * Real compiler diagnostics (M3, the OpenCode-parity "LSP/diagnostics" idea in
 * its robust form): run the repository's OWN typecheck command and feed its raw
 * output to `review`/the agent, so findings + fixes are anchored in real
 * compiler errors instead of hallucinated ones. Capturing the raw output (vs
 * parsing each tool's format) works for any typechecker/linter. A light
 * tsc-style scan gives a structured error line list for the summary.
 */

export interface DiagnosticLine {
  file: string;
  line: number;
  message: string;
}

export interface DiagnosticsResult {
  /** Whether a command was configured + actually run. */
  ran: boolean;
  /** Exit 0 (clean) vs non-zero (errors). `null` when not run. */
  ok: boolean | null;
  /** Combined stdout+stderr (truncated), the source of truth fed to the model. */
  output: string;
  /** Best-effort structured errors parsed from tsc-style lines. */
  diagnostics: DiagnosticLine[];
}

const MAX_OUTPUT_CHARS = 8000;
const DEFAULT_TIMEOUT_MS = 120_000;

/** `path(line,col): error TSxxxx: message` (tsc) and `path:line:col: error: message`. */
const TSC_LINE = /^(.+?)[(:](\d+)[,:]\d+\)?:?\s+error\b[^:]*:\s*(.+)$/;

/** Parses tsc-style error lines from raw compiler output (best-effort). */
function parseDiagnostics(output: string): DiagnosticLine[] {
  const found: DiagnosticLine[] = [];
  for (const raw of output.split('\n')) {
    const match = raw.trim().match(TSC_LINE);
    if (match !== null) {
      found.push({ file: match[1]!.trim(), line: Number.parseInt(match[2]!, 10), message: match[3]!.trim() });
    }
  }
  return found.slice(0, 100);
}

/**
 * Runs `command` in `repoRoot` and captures its diagnostics. Never throws — a
 * non-zero exit (the normal "there are errors" case) is captured as data. An
 * absent command yields `{ ran: false }`.
 */
export function runDiagnostics(
  repoRoot: string,
  command: string | undefined,
  options: { timeoutMs?: number } = {},
): DiagnosticsResult {
  if (command === undefined || command.trim().length === 0) {
    return { ran: false, ok: null, output: '', diagnostics: [] };
  }
  let output = '';
  let ok: boolean;
  try {
    output = execSync(command, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    ok = true;
  } catch (error) {
    // Non-zero exit: the typechecker reported errors. Capture its output.
    const e = error as { stdout?: Buffer | string; stderr?: Buffer | string };
    output = `${(e.stdout ?? '').toString()}\n${(e.stderr ?? '').toString()}`.trim();
    ok = false;
  }
  const trimmed = output.length > MAX_OUTPUT_CHARS ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]` : output;
  return { ran: true, ok, output: trimmed, diagnostics: parseDiagnostics(output) };
}

/**
 * Formats diagnostics as a context source for the effective instructions —
 * returns `null` when nothing ran or the typecheck was clean (no noise added).
 */
export function diagnosticsContextSource(result: DiagnosticsResult): AdditionalContextSource | null {
  if (!result.ran || result.ok === true || result.output.trim().length === 0) {
    return null;
  }
  return {
    path: 'diagnostics',
    title: 'Compiler diagnostics (real typecheck output)',
    content:
      'The repository typecheck reported the following — anchor your review/fixes on these REAL ' +
      'errors, do not invent others:\n\n' +
      result.output,
    precedence: 6,
  };
}
