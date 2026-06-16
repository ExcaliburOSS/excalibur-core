import type { ExcaliburEvent, RunRecord } from '@excalibur/shared';
import { Writable } from 'node:stream';
import { CliUsageError } from '../errors';
import type { CliDeps } from '../deps';
import { Ui } from '../ui';

/** The machine-readable run payload emitted by `json` / `stream-json`. */
export interface RunOutputPayload {
  /** The finished run record (`run.json`). */
  run: RunRecord;
  /** The run's event stream (`events.jsonl`), in occurrence order. */
  events: ExcaliburEvent[];
}

/**
 * Output format for `excalibur run` (headless / scripting support, OSS spec
 * §4.9). All three formats are PROJECTIONS of the same run event stream — the
 * run executes identically regardless of the chosen format:
 *
 * - `text` (default): today's human-readable terminal output, unchanged.
 * - `json`: the full run as a single JSON document (`{ run, events }`) printed
 *   once the run finishes. Ideal for `excalibur run ... | jq`.
 * - `stream-json`: one {@link ExcaliburEvent} per line as JSON, emitted in the
 *   order they occurred (JSON Lines / NDJSON). Ideal for streaming consumers.
 */
export const RUN_OUTPUT_FORMATS = ['text', 'json', 'stream-json'] as const;

/** A validated `--output-format` value. */
export type RunOutputFormat = (typeof RUN_OUTPUT_FORMATS)[number];

/**
 * Validates an `--output-format` flag value. Returns `undefined` for an absent
 * flag (the caller defaults to `text`); throws {@link CliUsageError} for an
 * unknown value so the failure is a clean usage error, not a crash.
 */
export function parseOutputFormat(value: string | undefined): RunOutputFormat | undefined {
  if (value === undefined) {
    return undefined;
  }
  if ((RUN_OUTPUT_FORMATS as readonly string[]).includes(value)) {
    return value as RunOutputFormat;
  }
  throw new CliUsageError(
    `--output-format must be one of: ${RUN_OUTPUT_FORMATS.join(', ')} (got "${value}").`,
  );
}

/** A `Writable` that discards every chunk (a `/dev/null` sink). */
class NullStream extends Writable {
  override _write(_chunk: unknown, _encoding: string, callback: () => void): void {
    callback();
  }
}

/**
 * Builds a derived {@link CliDeps} for the machine-readable run formats
 * (`json` / `stream-json`).
 *
 * The human-facing chatter (`run started`, per-event lines, the trailing
 * summary) is written through `deps.ui` to stdout; in a scripting context that
 * noise would corrupt the JSON/JSON-Lines a consumer is parsing. So we swap in
 * a quiet `Ui` whose stdout is discarded while keeping the original stderr live
 * (errors must still surface) and forcing non-interactive prompts so a piped
 * run never blocks waiting for input. The original `deps` (and its real stdout)
 * are returned untouched for the caller to emit the machine output through.
 */
export function quietDepsForMachineOutput(deps: CliDeps): CliDeps {
  const quietUi = new Ui({
    stdout: new NullStream(),
    // Keep stderr live: warnings/errors must still surface in CI logs while the
    // machine-readable payload owns stdout.
    stderr: process.stderr,
    interactive: false,
  });
  return { ...deps, ui: quietUi };
}

/**
 * Emits the run's events in the requested machine-readable format through the
 * given (real) `Ui`:
 *
 * - `json` prints `{ run, events }` as one pretty-printed JSON document.
 * - `stream-json` prints each event as a compact single JSON line (NDJSON).
 *
 * `text` is a no-op here (the human output is produced by the run itself).
 */
export function emitRunOutput(
  ui: CliDeps['ui'],
  format: RunOutputFormat,
  result: RunOutputPayload,
): void {
  if (format === 'stream-json') {
    for (const event of result.events) {
      ui.write(JSON.stringify(event));
    }
    return;
  }
  if (format === 'json') {
    ui.json({ run: result.run, events: result.events });
  }
}
