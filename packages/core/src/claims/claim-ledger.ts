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
  | 'requirement_met'
  // F7: a research claim that must be SUPPORTED by the cited sources.
  | 'cited'
  // F8: fetched/MCP sources must be free of prompt-injection.
  | 'source_trust';

export type ClaimStatus = 'verified' | 'refuted' | 'unverified';

export interface ClaimVerdict {
  kind: ClaimKind;
  statement: string;
  status: ClaimStatus;
  /** True when the MODEL itself asserted this (vs. an implied run-level claim). */
  asserted: boolean;
  evidence?: string;
}

/** A single research claim's verification verdict (F7, from the pipeline). */
export interface ResearchClaimEvidence {
  claim: string;
  verified: boolean;
}

/** A fetched source's provenance + injection verdict (F8, from `provenance` events). */
export interface SourceProvenanceEvidence {
  source: string;
  url?: string;
  verdict: 'clean' | 'suspicious' | 'malicious';
  blocked: boolean;
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
  /** Research claim verdicts (F7); each becomes a `cited` claim. */
  research?: ReadonlyArray<ResearchClaimEvidence>;
  /** When true (config research.ledger), an unsupported research claim BLOCKS. */
  researchLedger?: boolean;
  /** Provenance of fetched/MCP sources (F8); folds into a `source_trust` claim. */
  provenance?: ReadonlyArray<SourceProvenanceEvidence>;
  /** When true (config web.injection.blockOnMalicious), a malicious source BLOCKS. */
  blockOnMalicious?: boolean;
}

/** Human-readable statement per claim kind. */
const STATEMENT: Record<ClaimKind, string> = {
  tests_pass: 'the tests pass',
  no_type_errors: 'there are no type errors',
  no_secrets: 'no secrets were introduced',
  builds: 'the project builds',
  requirement_met: 'the stated requirement is met',
  cited: 'the cited claim is supported by sources',
  source_trust: 'fetched sources are free of prompt-injection',
};

/**
 * Claim kinds whose refutation BLOCKS the run from completing. `cited` and
 * `source_trust` are blocking, but they are only EMITTED as `refuted` when the
 * relevant config opt-in is on (research.ledger / web.injection.blockOnMalicious),
 * so they never block unless the user asked them to.
 */
const BLOCKING_KINDS: ReadonlySet<ClaimKind> = new Set<ClaimKind>([
  'tests_pass',
  'no_type_errors',
  'no_secrets',
  'builds',
  'cited',
  'source_trust',
]);

const CLAIM_PATTERNS: ReadonlyArray<{ kind: ClaimKind; re: RegExp }> = [
  { kind: 'tests_pass', re: /\b(?:all\s+)?tests?\s+(?:are\s+)?(?:now\s+)?pass(?:ing|ed|es)?\b/i },
  { kind: 'tests_pass', re: /\b(?:the\s+)?(?:test\s+suite|tests?)\s+(?:is\s+)?green\b/i },
  { kind: 'no_type_errors', re: /\bno\s+type[\s-]?(?:errors?|issues?)\b/i },
  {
    kind: 'no_type_errors',
    re: /\btype[\s-]?check(?:ing|s)?\s+(?:is\s+)?(?:clean|pass(?:es|ed|ing)?)\b/i,
  },
  { kind: 'no_secrets', re: /\bno\s+(?:hard[\s-]?coded\s+)?secrets?\b/i },
  {
    kind: 'no_secrets',
    re: /\bno\s+(?:api\s+)?keys?\s+(?:were\s+)?(?:committed|added|introduced|leaked)\b/i,
  },
  {
    kind: 'builds',
    re: /\b(?:the\s+)?(?:project|build|app)\s+(?:builds|compiles)(?:\s+(?:cleanly|successfully))?\b/i,
  },
  { kind: 'builds', re: /\bbuild\s+(?:is\s+)?(?:successful|passing|green|clean)\b/i },
  {
    kind: 'requirement_met',
    re: /\brequirements?\s+(?:is|are|were|has been|have been)\s+(?:met|satisfied|fulfilled|implemented)\b/i,
  },
  {
    kind: 'requirement_met',
    re: /\b(?:implemented|completed|done)\s+(?:exactly\s+)?as\s+(?:requested|specified|described)\b/i,
  },
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

  const fromBool = (kind: ClaimKind, passed: boolean | null, label: string): void => {
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
    verdicts.push({
      kind,
      statement: STATEMENT[kind],
      status,
      asserted: isAsserted,
      evidence: evidenceText,
    });
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

  // cited (F7): one verdict per research claim. A verified claim → verified; an
  // unsupported claim → refuted ONLY when the research ledger is enabled (else
  // surfaced as unverified so it never blocks an exploratory research turn).
  for (const r of evidence.research ?? []) {
    const status: ClaimStatus = r.verified
      ? 'verified'
      : evidence.researchLedger === true
        ? 'refuted'
        : 'unverified';
    verdicts.push({
      kind: 'cited',
      statement: `cited: ${r.claim.slice(0, 100)}`,
      status,
      asserted: true,
      evidence: r.verified ? 'supported by the cited sources' : 'not supported by enough sources',
    });
  }

  // source_trust (F8): a single verdict over the fetched/MCP sources. Malicious
  // content → refuted ONLY when blockOnMalicious is set (else unverified — the
  // content was already quarantined/fenced; the run is not failed by default).
  const provenance = evidence.provenance ?? [];
  if (provenance.length > 0) {
    const malicious = provenance.filter((p) => p.verdict === 'malicious');
    const status: ClaimStatus =
      malicious.length === 0
        ? 'verified'
        : evidence.blockOnMalicious === true
          ? 'refuted'
          : 'unverified';
    verdicts.push({
      kind: 'source_trust',
      statement: STATEMENT.source_trust,
      status,
      asserted: false,
      evidence:
        malicious.length === 0
          ? `${provenance.length} source(s) scanned clean`
          : `${malicious.length} of ${provenance.length} source(s) flagged as prompt-injection`,
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
