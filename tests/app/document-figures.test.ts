import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The date on a document, and the figure a check certifies.
 *
 * Both of these were wrong on screen while every stored value behind them was
 * right, so no assertion about the ledger could have caught either. They are
 * pinned against the page source for the same reason `print.test.ts` is: what
 * a server component paints cannot be captured here, and these two lines are
 * load-bearing enough to be worth pinning anyway. A companion test in
 * `tests/services/year-end-check-line.test.ts` proves the two trial-balance
 * measures really do differ, so the distinction below is not academic.
 */

const read = (...parts: string[]): string =>
  readFileSync(join(process.cwd(), 'src', 'app', ...parts), 'utf8');

const RECEIPT = read('(app)', 'sales', '[id]', 'receipt', 'page.tsx');
const INVOICE = read('(app)', 'sales', '[id]', 'invoice', 'page.tsx');
const YEAR_END = read('(app)', 'reports', 'year-end', 'page.tsx');

describe('the date a sale document prints', () => {
  /**
   * `occurredAt` is when the row was written; `businessDate` is when the shop
   * traded. They agree at the till and diverge everywhere else — yesterday's
   * takings entered this morning, a quotation converted today for the day it
   * was agreed. The receipt printed `occurredAt` and so dated a June sale to
   * the day the database happened to be written.
   */
  it('is the trading date, on the receipt', () => {
    expect(RECEIPT).toContain('formatDate(sale.businessDate)');
  });

  it('never dates a receipt by when the row was written', () => {
    expect(RECEIPT).not.toContain('formatDateTime(sale.occurredAt)');
  });

  /** The invoice was always right. It is here so the pair cannot drift apart. */
  it('is the trading date, on the invoice', () => {
    expect(INVOICE).toContain('formatDate(sale.businessDate)');
  });
});

describe('what the year-end pack certifies', () => {
  /**
   * The pack prints a trial balance of NET account balances as at the year end
   * and used to certify it with `integrity`, which sums every journal line ever
   * posted, gross and undated. Two true figures, one label, one page — and it
   * is the accountant, who cannot see the code, left to work out which is which.
   */
  it('quotes the totals of the trial balance it printed', () => {
    expect(YEAR_END).toContain('pack.trialBalance.balanced');
    expect(YEAR_END).toContain('moneyAccounting(pack.trialBalance.totalDebit');
    expect(YEAR_END).toContain('moneyAccounting(pack.trialBalance.totalCredit');
  });

  /** The whole-ledger check is still worth making — it just needs its own words. */
  it('keeps the whole-ledger check, named so it cannot be read as the other one', () => {
    expect(YEAR_END).toContain('Every entry ever posted');
    expect(YEAR_END).toMatch(/gross debits/);
  });
});
