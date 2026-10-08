import { describe, expect, it } from 'vitest';
import { minor } from '@/domain/money';
import {
  dashboardPeriod,
  dashboardRangeHref,
  dashboardDailySeries,
  summariseAgeing,
  reconciliationIssues,
  integrityChecks,
} from '@/lib/dashboard';
import type {
  AgeingRow,
  BooksIntegrity,
} from '@/services/reporting/ledger.service';
import type { AccountReconciliationState } from '@/services/reconciliation.service';

describe('dashboard periods', () => {
  it('preserves original inclusive windows across calendar boundaries', () => {
    expect(dashboardPeriod('2026-03-01', 'week')).toEqual({
      from: '2026-02-22',
      to: '2026-03-01',
    });
    expect(dashboardPeriod('2024-03-01', 'month')).toEqual({
      from: '2024-01-31',
      to: '2024-03-01',
    });
    expect(dashboardRangeHref('week', 'quarter')).toBe(
      '/dashboard?sales=week&spend=quarter',
    );
    expect(dashboardRangeHref('month', 'quarter')).toBe(
      '/dashboard?sales=month&spend=quarter',
    );
    expect(dashboardRangeHref('week', 'month')).toBe(
      '/dashboard?sales=week&spend=month',
    );
  });
  it('includes both boundaries and confirmed zero-transaction days in charts', () => {
    expect(
      dashboardDailySeries(
        [{ businessDate: '2026-03-01', total: minor(100) }],
        { from: '2026-02-28', to: '2026-03-02' },
      ),
    ).toEqual([
      { label: '02-28', value: 0 },
      { label: '03-01', value: 100 },
      { label: '03-02', value: 0 },
    ]);
  });
});
describe('dashboard financial classification', () => {
  it('includes every overdue bucket exactly once and reconciles to outstanding', () => {
    const row = {
      current: minor(100),
      days1to30: minor(200),
      days31to60: minor(300),
      days61to90: minor(400),
      over90: minor(500),
    } as AgeingRow;
    expect(summariseAgeing([row], minor(1500))).toEqual({
      overdue: 1400,
      notYetDue: 100,
      agedTotal: 1500,
      unaged: 0,
      reconciles: true,
    });
  });
  it('exposes unallocated ledger credits without giving them an invented due date', () => {
    const row = {
      current: minor(100),
      days1to30: minor(200),
      days31to60: minor(0),
      days61to90: minor(0),
      over90: minor(0),
    } as AgeingRow;
    expect(summariseAgeing([row], minor(250))).toMatchObject({
      overdue: 200,
      notYetDue: 100,
      unaged: -50,
      reconciles: false,
    });
  });
  it('does not allow opposite account differences to hide each other', () => {
    const rows = [
      { paymentAccountId: 1, unresolvedDifference: minor(100) },
      { paymentAccountId: 2, unresolvedDifference: minor(-100) },
      { paymentAccountId: 3, unresolvedDifference: minor(0) },
    ] as AccountReconciliationState[];
    expect(
      reconciliationIssues(rows).map((row) => row.paymentAccountId),
    ).toEqual([1, 2]);
  });
  it('does not treat balanced totals as passing every integrity check', () => {
    const check: BooksIntegrity = {
      trialBalanced: true,
      totalDebit: minor(100),
      totalCredit: minor(100),
      difference: minor(0),
      unbalancedEntries: [{ id: 1, entryNo: 'J1', difference: minor(10) }],
      receivablesMatch: false,
      payablesMatch: true,
      untracedEntries: 1,
    };
    expect(integrityChecks(check).map((row) => row.passed)).toEqual([
      true,
      false,
      false,
      true,
      false,
    ]);
  });
});
