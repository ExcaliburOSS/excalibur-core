import { redactSecrets } from '@excalibur/model-gateway';

/**
 * The CLAIM LEDGER (plan P2.4) — the deterministic, evidence-linked truth check.
 *
 * A model that says "tests pass" or "no secrets" might be wrong. This module
 * turns those assertions (parsed from the model's final message) and the run's
 * implied claims into a typed ledger and AUTO-VERIFIES each against real tool
 * evidence — test exit codes, the typecheck/build outcome, a secret scan of the
 * diff — stamping verified|refuted|unverified. A claim the model ASSERTED but
 * the evidence REFUTES is the model lying; a secret in the diff is refuted
 * regardless. Both block the run from `completed`. Unlike an LLM-judge grader,
 * every verdict points at a concrete check (replayable + auditable).
 *
 * Pure + deterministic: the run engine extracts {@link ClaimEvidence} from its
 * event stream and calls {@link buildClaimLedger}; this module never runs tools.
 */

export type ClaimKind =
  | 'tests_pass'
  | 'no_type_errors'
  | 'no_secrets'
  | 'builds'
  | 'requirement_met';

export type ClaimStatus = 'verified' | 'refuted' | 'unverified';

export interface ClaimVerdict {
  kind: ClaimKind;
  statement: string;
  status: ClaimStatus;
  /** True when the MODEL itself asserted this (vs. an implied run-level claim). */
  asserted: boolean;
  evidence?: string;
}

/** Real evidence the run gathered, extracted from its event stream. */
export interface ClaimEvidence {
  /** Test command outcome (from command_group / test_result), or null if none ran. */
  testsPassed: boolean | null;
  /** Typecheck command outcome, or null if none ran. */
  typecheckPassed: boolean | null;
  /** Build command outcome, or null if none ran. */
  buildPassed: boolean | null;
  /** The collected unified diff, for the secret scan (null/empty → no diff). */
  diff: string | null;
}

/** Human-readable statement per claim kind. */
const STATEMENT: Record<ClaimKind, string> = {
  tests_pass: 'the tests pass',
  no_type_errors: 'there are no type errors',
  no_secrets: 'no secrets were introduced',
  builds: 'the project builds',
  requirement_met: 'the stated requirement is met',
};

/** Claim kinds whose refutation BLOCKS the run from completing. */
const BLOCKING_KINDS: ReadonlySet<ClaimKind> = new Set<ClaimKind>([
  'tests_pass',
  'no_type_errors',
  'no_secrets',
  'builds',
]);

const CLAIM_PATTERNS: ReadonlyArray<{ kind: ClaimKind; re: RegExp }> = [
  { kind: 'tests_pass', re: /\b(?:all\s+)?tests?\s+(?:are\s+)?(?:now\s+)?pass(?:ing|ed|es)?\b/i },
  { kind: 'tests_pass', re: /\b(?:the\s+)?(?:test\s+suite|tests?)\s+(?:is\s+)?green\b/i },
  { kind: 'no_type_errors', re: /\bno\s+type[\s-]?(?:errors?|issues?)\b/i },
  { kind: 'no_type_errors', re: /\btype[\s-]?check(?:ing|s)?\s+(?:is\s+)?(?:clean|pass(?:es|ed|ing)?)\b/i },
  { kind: 'no_secrets', re: /\bno\s+(?:hard[\s-]?coded\s+)?secrets?\b/i },
  { kind: 'no_secrets', re: /\bno\s+(?:api\s+)?keys?\s+(?:were\s+)?(?:committed|added|introduced|leaked)\b/i },
  { kind: 'builds', re: /\b(?:the\s+)?(?:project|build|app)\s+(?:builds|compiles)(?:\s+(?:cleanly|successfully))?\b/i },
  { kind: 'builds', re: /\bbuild\s+(?:is\s+)?(?:successful|passing|green|clean)\b/i },
  { kind: 'requirement_met', re: /\brequirements?\s+(?:is|are|were|has been|have been)\s+(?:met|satisfied|fulfilled|implemented)\b/i },
  { kind: 'requirement_met', re: /\b(?:implemented|completed|done)\s+(?:exactly\s+)?as\s+(?:requested|specified|described)\b/i },
];

/** Parses the model's final message for the claims it explicitly made. */
export function extractAssertedClaims(text: string): Set<ClaimKind> {
  const found = new Set<ClaimKind>();
  if (text.trim().length === 0) {
    return found;
  }
  for (const { kind, re } of CLAIM_PATTERNS) {
    if (re.test(text)) {
      found.add(kind);
    }
  }
  return found;
}

/**
 * Does the diff introduce a secret? Only ADDED (`+`) lines matter — context may
 * legitimately mention keys. Catches BOTH a raw secret (the redactor changes the
 * text) AND a diff that was already redacted upstream (the `[REDACTED]` marker in
 * an added line means a secret was present and masked — still a leak attempt).
 */
function diffHasSecret(diff: string): boolean {
  const added = diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n');
  if (added.length === 0) {
    return false;
  }
  return added.includes('[REDACTED]') || redactSecrets(added) !== added;
}

/**
 * Builds the claim ledger: one verdict per relevant claim. A claim is included
 * when the model asserted it OR the run produced evidence to check it against
 * (so `no_secrets` is always checked when there is a diff, and `tests_pass`
 * whenever tests ran). Pure + deterministic.
 */
export function buildClaimLedger(finalText: string, evidence: ClaimEvidence): ClaimVerdict[] {
  const asserted = extractAssertedClaims(finalText);
  const verdicts: ClaimVerdict[] = [];

  const fromBool = (
    kind: ClaimKind,
    passed: boolean | null,
    label: string,
  ): void => {
    const isAsserted = asserted.has(kind);
    // Record when checkable (ran) or asserted (we want to flag an unbacked claim).
    if (passed === null && !isAsserted) {
      return;
    }
    const status: ClaimStatus = passed === null ? 'unverified' : passed ? 'verified' : 'refuted';
    const evidenceText =
      passed === null
        ? `${label} did not run — no evidence to verify the claim`
        : `${label} ${passed ? 'passed' : 'failed'}`;
    verdicts.push({ kind, statement: STATEMENT[kind], status, asserted: isAsserted, evidence: evidenceText });
  };

  fromBool('tests_pass', evidence.testsPassed, 'test command');
  fromBool('no_type_errors', evidence.typecheckPassed, 'typecheck');
  fromBool('builds', evidence.buildPassed, 'build');

  // no_secrets: always check when there is a diff (high value, model-independent).
  const diff = evidence.diff ?? '';
  if (diff.trim().length > 0 || asserted.has('no_secrets')) {
    const hasSecret = diff.trim().length > 0 ? diffHasSecret(diff) : false;
    const status: ClaimStatus =
      diff.trim().length === 0 ? 'unverified' : hasSecret ? 'refuted' : 'verified';
    verdicts.push({
      kind: 'no_secrets',
      statement: STATEMENT.no_secrets,
      status,
      asserted: asserted.has('no_secrets'),
      evidence:
        diff.trim().length === 0
          ? 'no diff to scan'
          : hasSecret
            ? 'a secret-like token was found in the added lines'
            : 'secret scan of the added lines found nothing',
    });
  }

  // requirement_met is not tool-verifiable — record it (unverified) only when the
  // model asserted it, so a human knows it still needs checking. Never blocks.
  if (asserted.has('requirement_met')) {
    verdicts.push({
      kind: 'requirement_met',
      statement: STATEMENT.requirement_met,
      status: 'unverified',
      asserted: true,
      evidence: 'no automated check — needs human/spec verification',
    });
  }

  return verdicts;
}

/**
 * Does the ledger block the run? A refuted claim of a blocking kind means the
 * stated success is false (the model lied, or a secret slipped in) → the run
 * must not reach `completed`.
 */
export function ledgerBlocks(verdicts: ReadonlyArray<ClaimVerdict>): boolean {
  return verdicts.some((v) => v.status === 'refuted' && BLOCKING_KINDS.has(v.kind));
}

/** One-line summary of the ledger for the run's audit + the rail. */
export function summarizeLedger(verdicts: ReadonlyArray<ClaimVerdict>): string {
  if (verdicts.length === 0) {
    return 'Claim ledger: no checkable claims.';
  }
  const counts = { verified: 0, refuted: 0, unverified: 0 };
  for (const v of verdicts) counts[v.status] += 1;
  const blocked = ledgerBlocks(verdicts);
  return `Claim ledger: ${counts.verified} verified, ${counts.refuted} refuted, ${counts.unverified} unverified${blocked ? ' (BLOCKING)' : ''}.`;
}
