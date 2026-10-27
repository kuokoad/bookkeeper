import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { accountTransfers, journalEntries, paymentAccounts } from '@/db/schema';
import { recordOwnerCapital } from '@/services/cashbook.service';
import {
  getAccountMovements,
  getPaymentAccountBalance,
  setPaymentAccountActive,
} from '@/services/payment-account.service';
import { setBooksLock } from '@/services/period-lock.service';
import { listTransfers, recordTransfer, voidTransfer } from '@/services/transfer.service';
import { getAccountBalanceByCode, getTrialBalance } from '@/services/reporting/balances.service';
import { getCashFlow, getNetProfit } from '@/services/reporting/financial.service';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { minor } from '@/domain/money';
import { PeriodLockedError } from '@/domain/accounting/period-lock';

/**
 * Banking the day's cash.
 *
 * A transfer is the one movement that should change WHERE the shop's money is
 * and nothing else: not the total held, not the profit, not the owner's
 * capital or drawings. Before this existed, the workaround was a drawings
 * entry out of Cash and a capital entry into Bank — balances right, equity
 * lines wrong. These assert what an owner would check on each screen.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };

let cash = 0;
let bank = 0;
let momo = 0;

const balanceOf = (id: number) => getPaymentAccountBalance(context.db, id);
const totalHeld = () => balanceOf(cash) + balanceOf(bank) + balanceOf(momo);

function bankCash(amount: number, businessDate = '2026-08-10') {
  return recordTransfer(
    context.db,
    { businessDate, fromAccountId: cash, toAccountId: bank, amount: minor(amount) },
    ACTOR,
  );
}

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');

  const accounts = context.db.select().from(paymentAccounts).all();
  cash = accounts.find((a) => a.kind === 'CASH')!.id;
  bank = accounts.find((a) => a.kind === 'BANK')!.id;
  momo = accounts.find((a) => a.kind === 'MOBILE_MONEY')!.id;

  // GHS 1,000.00 in the drawer to start with.
  recordOwnerCapital(
    context.db,
    { businessDate: '2026-08-01', paymentAccountId: cash, amount: minor(100_000) },
    ACTOR,
  );
});

afterEach(() => context.cleanup());

describe('banking cash', () => {
  it('takes it out of Cash and puts it in the Bank', () => {
    bankCash(60_000);

    expect(balanceOf(cash)).toBe(40_000);
    expect(balanceOf(bank)).toBe(60_000);
  });

  it('leaves the total money held exactly where it was', () => {
    const before = totalHeld();
    bankCash(60_000);

    expect(totalHeld()).toBe(before);
  });

  it('touches neither the profit nor the owner’s capital and drawings', () => {
    const capitalBefore = getAccountBalanceByCode(context.db, ACCOUNT_CODES.OWNERS_CAPITAL);
    const drawingsBefore = getAccountBalanceByCode(context.db, ACCOUNT_CODES.OWNERS_DRAWINGS);

    bankCash(60_000);

    expect(getNetProfit(context.db, { from: '2026-08-01', to: '2026-08-31' })).toBe(0);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.OWNERS_CAPITAL)).toBe(capitalBefore);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.OWNERS_DRAWINGS)).toBe(drawingsBefore);
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });

  it('is posted on the day the money moved, and numbered', () => {
    const result = bankCash(60_000, '2026-08-10');

    expect(result.transferNo).toBe('TRF-00001');
    const entry = context.db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, result.journalEntryId))
      .get();
    expect(entry?.entryDate).toBe('2026-08-10');
    expect(entry?.sourceType).toBe('TRANSFER');
  });

  it('shows on both statements: out of Cash, into the Bank', () => {
    bankCash(60_000);

    const cashOut = getAccountMovements(context.db, cash).find((m) => m.sourceType === 'TRANSFER');
    const bankIn = getAccountMovements(context.db, bank).find((m) => m.sourceType === 'TRANSFER');
    expect(cashOut?.outMinor).toBe(60_000);
    expect(bankIn?.inMinor).toBe(60_000);
  });

  it('is not money in or out of the shop on the cash flow, only between its accounts', () => {
    const { id } = bankCash(60_000);
    // A void posts a second TRANSFER entry; that is not money moving either.
    voidTransfer(context.db, id, 'Wrong amount', ACTOR, new Date(2026, 7, 20, 9, 0));
    bankCash(25_000, '2026-08-21');
    const period = { from: '2026-08-01', to: '2026-08-31' };

    const shop = getCashFlow(context.db, period);
    expect(shop.lines.find((l) => l.sourceType === 'TRANSFER')).toBeUndefined();
    // Only the owner's GHS 1,000 actually came into the business.
    expect(shop.totalIn).toBe(100_000);
    expect(shop.totalOut).toBe(0);
    expect(shop.netMovement).toBe(100_000);
    expect(shop.reconciles).toBe(true);

    // Each account on its own still shows the money arriving or leaving.
    const bankOnly = getCashFlow(context.db, period, bank);
    expect(bankOnly.lines.find((l) => l.sourceType === 'TRANSFER')?.inMinor).toBe(85_000);
    expect(bankOnly.netMovement).toBe(25_000);
    expect(getCashFlow(context.db, period, cash).netMovement).toBe(75_000);
  });
});

describe('what a transfer refuses', () => {
  it('the same account on both sides', () => {
    expect(() =>
      recordTransfer(
        context.db,
        { businessDate: '2026-08-10', fromAccountId: cash, toAccountId: cash, amount: minor(100) },
        ACTOR,
      ),
    ).toThrow(/two different accounts/i);
  });

  it('an amount of nothing', () => {
    expect(() => bankCash(0)).toThrow(/greater than zero/i);
  });

  it('an archived account', () => {
    setPaymentAccountActive(context.db, momo, false, ACTOR);

    expect(() =>
      recordTransfer(
        context.db,
        { businessDate: '2026-08-10', fromAccountId: cash, toAccountId: momo, amount: minor(100) },
        ACTOR,
      ),
    ).toThrow(/archived/i);
  });

  it('a date inside the books lock, and records nothing', () => {
    setBooksLock(context.db, '2026-08-15', ACTOR);

    expect(() => bankCash(60_000, '2026-08-15')).toThrow(PeriodLockedError);
    expect(context.db.select().from(accountTransfers).all()).toHaveLength(0);
    expect(balanceOf(cash)).toBe(100_000);

    // The day after the lock is open.
    bankCash(60_000, '2026-08-16');
    expect(balanceOf(bank)).toBe(60_000);
  });
});

describe('voiding a transfer', () => {
  it('puts both balances back and keeps the record', () => {
    const { id } = bankCash(60_000);

    voidTransfer(context.db, id, 'Wrong amount', ACTOR, new Date(2026, 7, 20, 9, 0));

    expect(balanceOf(cash)).toBe(100_000);
    expect(balanceOf(bank)).toBe(0);
    const [row] = listTransfers(context.db);
    expect(row?.status).toBe('VOIDED');
    expect(row?.voidReason).toBe('Wrong amount');
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });

  it('posts the reversal on the day of the void, not the day of the transfer', () => {
    const { id, journalEntryId } = bankCash(60_000, '2026-08-10');

    voidTransfer(context.db, id, 'Wrong amount', ACTOR, new Date(2026, 7, 20, 9, 0));

    const original = context.db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, journalEntryId))
      .get();
    const reversal = context.db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, original!.reversedByEntryId!))
      .get();
    expect(reversal?.entryDate).toBe('2026-08-20');
    expect(reversal?.sourceType).toBe('TRANSFER');
  });

  it('works on a transfer inside a closed period, without reopening it', () => {
    const { id } = bankCash(60_000, '2026-08-10');
    setBooksLock(context.db, '2026-08-15', ACTOR);

    voidTransfer(context.db, id, 'Banked twice', ACTOR, new Date(2026, 7, 20, 9, 0));

    expect(balanceOf(bank)).toBe(0);
    // Up to the lock date the books still say the money was banked.
    expect(getPaymentAccountBalance(context.db, bank, '2026-08-15')).toBe(60_000);
  });

  it('cannot be done twice', () => {
    const { id } = bankCash(60_000);
    voidTransfer(context.db, id, 'Wrong amount', ACTOR);

    expect(() => voidTransfer(context.db, id, 'Again', ACTOR)).toThrow(/already been voided/i);
    expect(balanceOf(cash)).toBe(100_000);
  });

  it('needs a reason', () => {
    const { id } = bankCash(60_000);

    expect(() => voidTransfer(context.db, id, '', ACTOR)).toThrow(/reason/i);
    expect(balanceOf(bank)).toBe(60_000);
  });
});
