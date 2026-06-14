import { type AutonomyLevel, type ExcaliburConfig } from '@excalibur/shared';
import { DEFAULT_SAFETY_PRESET_ID, SAFETY_PRESETS } from '../onboarding/onboarding';

/**
 * Structural input parsing + the StatusLine model for the M-Shell REPL.
 *
 * The shell is MODEL-FIRST: a natural-language line is handed to the agent loop,
 * which decides what to do (answer with read tools, or edit/run with write
 * tools), governed by the session's autonomy level — there is NO keyword
 * classifier deciding intent. This module therefore only recognises the two
 * STRUCTURAL forms (syntax, not language): a leading `/` slash command and a
 * leading `!` shell passthrough. Everything else is a natural-language turn the
 * REPL routes straight to the model.
 */

/** A discriminated decision describing the STRUCTURAL shape of one input line. */
export type StructuralInput =
  | { kind: 'command'; name: string; argv: string[] }
  | { kind: 'shell'; command: string }
  | { kind: 'natural'; text: string };

/** Tokenises an input line into argv, respecting simple quotes. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

/**
 * Recognises the STRUCTURAL shape of one REPL line — model-free and
 * deterministic:
 *
 * - leading `/` → a slash command (`/help`, `/plan`, `/exit`, …);
 * - leading `!` → a shell passthrough;
 * - otherwise a natural-language turn handed verbatim to the agent loop (the
 *   MODEL decides what to do — no keyword classification happens here).
 */
export function parseStructuralInput(text: string): StructuralInput {
  const trimmed = text.trim();

  if (trimmed.startsWith('/')) {
    const [name, ...argv] = tokenize(trimmed.slice(1));
    return { kind: 'command', name: (name ?? '').toLowerCase(), argv };
  }

  if (trimmed.startsWith('!')) {
    return { kind: 'shell', command: trimmed.slice(1).trim() };
  }

  return { kind: 'natural', text: trimmed };
}

/** The surface-agnostic model backing the StatusLine. */
export interface StatusLineModel {
  /** Autonomy label for the active lane / default. */
  autonomy: string;
  /** Active workflow id (or a lane label before a turn runs). */
  workflow: string;
  /** Provider/model name (e.g. `mock`). */
  model: string;
  /** Running cost sum, in cents. */
  costCents: number;
  /** Safety preset id. */
  safety: string;
}

export interface BuildStatusLineInput {
  config: ExcaliburConfig;
  /** Provider/model name from the gateway context. */
  model: string;
  /** Running cost sum so far, in cents. */
  costCents?: number;
  /** Autonomy level for the active lane (defaults to the config default). */
  autonomyLevel?: AutonomyLevel;
  /** Active workflow id / lane label. */
  workflow?: string;
}

/**
 * Builds the surface-agnostic {@link StatusLineModel} the CLI (and the future
 * Ink surface) render after each turn. Pure: no Ui, no IO.
 */
export function buildStatusLineModel(input: BuildStatusLineInput): StatusLineModel {
  const presetId = input.config.safety?.preset ?? DEFAULT_SAFETY_PRESET_ID;
  const safety = SAFETY_PRESETS[presetId] !== undefined ? presetId : DEFAULT_SAFETY_PRESET_ID;
  const autonomyLevel = input.autonomyLevel ?? input.config.autonomy?.default ?? 3;
  return {
    autonomy: AUTONOMY_LABELS[autonomyLevel] ?? `L${autonomyLevel}`,
    workflow: input.workflow ?? 'conversation',
    model: input.model,
    costCents: input.costCents ?? 0,
    safety,
  };
}

/** Compact autonomy labels for the StatusLine. */
const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  0: 'L0 Review',
  1: 'L1 Assist',
  2: 'L2 Patch',
  3: 'L3 Branch',
  4: 'L4 Agentic',
};
