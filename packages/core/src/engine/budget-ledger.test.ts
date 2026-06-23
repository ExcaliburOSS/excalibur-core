import { describe, expect, it } from 'vitest';
import { BudgetLedger, budgetCapCentsFromUsd } from './budget-ledger';

describe('BudgetLedger (AO4c)', () => {
  it('never exceeds when uncapped', () => {
    const l = new BudgetLedger(null);
    l.add(10_000);
    expect(l.exceeded()).toBe(false);
    expect(l.remainingCents()).toBe(Number.POSITIVE_INFINITY);
  });

  it('accumulates spend and trips at the cap', () => {
    const l = new BudgetLedger(100);
    l.add(40);
    expect(l.exceeded()).toBe(false);
    expect(l.remainingCents()).toBe(60);
    l.add(70);
    expect(l.spent).toBe(110);
    expect(l.exceeded()).toBe(true);
    expect(l.remainingCents()).toBe(0);
  });

  it('ignores null/NaN/≤0 contributions', () => {
    const l = new BudgetLedger(100);
    l.add(null);
    l.add(undefined);
    l.add(-5);
    l.add(Number.NaN);
    expect(l.spent).toBe(0);
  });
});

describe('budgetCapCentsFromUsd', () => {
  it('converts dollars to cents, else null', () => {
    expect(budgetCapCentsFromUsd(2.5)).toBe(250);
    expect(budgetCapCentsFromUsd(0)).toBeNull();
    expect(budgetCapCentsFromUsd(undefined)).toBeNull();
  });
});
