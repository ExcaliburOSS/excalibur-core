import { describe, expect, it } from 'vitest';
import {
  buildClaimLedger,
  extractAssertedClaims,
  ledgerBlocks,
  summarizeLedger,
  type ClaimEvidence,
} from './claim-ledger';

const NO_EVIDENCE: ClaimEvidence = {
  testsPassed: null,
  typecheckPassed: null,
  buildPassed: null,
  diff: null,
};

describe('extractAssertedClaims', () => {
  it('detects test/type/secret/build claims in the model message', () => {
    const claims = extractAssertedClaims(
      'I ran the suite and all tests pass. Typecheck is clean, no secrets were introduced, and the project builds successfully.',
    );
    expect(claims.has('tests_pass')).toBe(true);
    expect(claims.has('no_type_errors')).toBe(true);
    expect(claims.has('no_secrets')).toBe(true);
    expect(claims.has('builds')).toBe(true);
  });

  it('does not hallucinate claims from neutral prose', () => {
    expect([...extractAssertedClaims('I added a multiply function to the math module.')]).toEqual([]);
  });
});

describe('buildClaimLedger', () => {
  it('REFUTES an asserted "tests pass" when the test command actually failed (the model lied)', () => {
    const verdicts = buildClaimLedger('All tests pass now.', {
      ...NO_EVIDENCE,
      testsPassed: false,
    });
    const tp = verdicts.find((v) => v.kind === 'tests_pass');
    expect(tp?.status).toBe('refuted');
    expect(tp?.asserted).toBe(true);
    expect(ledgerBlocks(verdicts)).toBe(true);
    expect(summarizeLedger(verdicts)).toContain('BLOCKING');
  });

  it('VERIFIES an asserted "tests pass" when the test command passed', () => {
    const verdicts = buildClaimLedger('Tests are green.', { ...NO_EVIDENCE, testsPassed: true });
    expect(verdicts.find((v) => v.kind === 'tests_pass')?.status).toBe('verified');
    expect(ledgerBlocks(verdicts)).toBe(false);
  });

  it('records an asserted claim as UNVERIFIED when no tool ran (no false comfort)', () => {
    const verdicts = buildClaimLedger('All tests pass.', NO_EVIDENCE);
    const tp = verdicts.find((v) => v.kind === 'tests_pass');
    expect(tp?.status).toBe('unverified');
    expect(ledgerBlocks(verdicts)).toBe(false);
  });

  it('REFUTES no_secrets when the diff adds a secret — even if the model never claimed it', () => {
    const diff = [
      'diff --git a/src/config.ts b/src/config.ts',
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1 +1,2 @@',
      ' export const region = "eu";',
      '+export const apiKey = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";',
    ].join('\n');
    const verdicts = buildClaimLedger('Added the config.', { ...NO_EVIDENCE, diff });
    const ns = verdicts.find((v) => v.kind === 'no_secrets');
    expect(ns?.status).toBe('refuted');
    expect(ns?.asserted).toBe(false);
    expect(ledgerBlocks(verdicts)).toBe(true);
  });

  it('VERIFIES no_secrets for a clean diff', () => {
    const diff = [
      'diff --git a/src/math.ts b/src/math.ts',
      '+++ b/src/math.ts',
      '@@ -0,0 +1,1 @@',
      '+export const add = (a, b) => a + b;',
    ].join('\n');
    const verdicts = buildClaimLedger('Done.', { ...NO_EVIDENCE, diff });
    expect(verdicts.find((v) => v.kind === 'no_secrets')?.status).toBe('verified');
  });

  it('records requirement_met as unverified-only-when-asserted and never blocks', () => {
    const verdicts = buildClaimLedger('The requirement is met.', NO_EVIDENCE);
    const rm = verdicts.find((v) => v.kind === 'requirement_met');
    expect(rm?.status).toBe('unverified');
    expect(ledgerBlocks(verdicts)).toBe(false);
  });

  it('is empty when nothing is asserted and no evidence exists', () => {
    expect(buildClaimLedger('I made some edits.', NO_EVIDENCE)).toEqual([]);
  });
});
