import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getYearEndPack } from '@/services/reporting/year-end.service';
import { postJournalEntry } from '@/services/journal.service';
import { credit, debit } from '@/domain/accounting/journal';
import { minor } from '@/domain/money';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { createTestDatabase, accountIdFor, type TestDatabase } from '../helpers/test-db';

/**
 * The two ways to total a trial balance, and why the pack must not mix them.
 *
 * `trialBalance` sums each account's NET balance as at the year end.
 * `integrity` sums every debit and credit line ever posted, gross and undated.
 * Both prove the books balance. They are not the same number, and the year-end
 * pack printed one under a table showing the other.
 *
 * This test exists to stop anyone "simplifying" the two back into one on the
 * grounds that they look interchangeable in a shop that has only ever posted a
 * single entry. The moment an account is posted to on both sides, they part.
 */

let context: TestDatabase;

beforeEach(() => {
  context = createTestDatabase();
});

afterEach(() => {
  context.cleanup();
});

const account = (code: string) => accountIdFor(context.db, code);

function post(entryDate: string, debitCode: string, creditCode: string, amount: number): void {
  postJournalEntry(
    context.db,
    {
      entryDate,
      memo: 'test entry',
      sourceType: 'OPENING_BALANCE',
      isOpening: true,
      lines: [debit(account(debitCode), minor(amount)), credit(account(creditCode), minor(amount))],
    },
    null,
  );
}

describe('the year-end pack trial balance', () => {
  it('balances on both measures', () => {
    post('2026-03-04', '1001', ACCOUNT_CODES.OWNERS_CAPITAL, 70_000_00);
    post('2026-05-19', ACCOUNT_CODES.OWNERS_CAPITAL, '1001', 12_000_00);

    const pack = getYearEndPack(context.db, 2026);

    expect(pack.trialBalance.balanced).toBe(true);
    expect(pack.trialBalance.totalDebit).toBe(pack.trialBalance.totalCredit);
    expect(pack.integrity.trialBalanced).toBe(true);
    expect(pack.integrity.totalDebit).toBe(pack.integrity.totalCredit);
  });

  /**
   * The heart of it. Cash is debited 70,000 and credited 12,000, so gross
   * movement is 82,000 a side while the net balance is 58,000. A check line
   * quoting the gross figure under the net table is off by 24,000 with no
   * arithmetic anywhere to explain the gap.
   */
  it('nets to a different figure from the whole-ledger gross total', () => {
    post('2026-03-04', '1001', ACCOUNT_CODES.OWNERS_CAPITAL, 70_000_00);
    post('2026-05-19', ACCOUNT_CODES.OWNERS_CAPITAL, '1001', 12_000_00);

    const pack = getYearEndPack(context.db, 2026);

    expect(pack.trialBalance.totalDebit).toBe(58_000_00);
    expect(pack.integrity.totalDebit).toBe(82_000_00);
    expect(pack.trialBalance.totalDebit).not.toBe(pack.integrity.totalDebit);
  });
});
