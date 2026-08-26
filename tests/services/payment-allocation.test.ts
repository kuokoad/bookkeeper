import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, accountIdFor, type TestDatabase } from '../helpers/test-db';
import { customerPaymentAllocations, journalEntries, journalLines, paymentAccounts } from '@/db/schema';
import { createProduct } from '@/services/catalog.service';
import { createCustomer, getCustomerBalance } from '@/services/customer.service';
import { createSale, getSaleOutstanding } from '@/services/sale.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { recordCustomerPayment } from '@/services/customer-payment.service';
import { postJournalEntry, reverseJournalEntry } from '@/services/journal.service';
import { getAccountBalanceByCode, getTrialBalance } from '@/services/reporting/balances.service';
import { credit, debit } from '@/domain/accounting/journal';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { ValidationError } from '@/domain/errors';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';
import { writeTransaction } from '@/db/transaction';

/**
 * Which invoices a payment pays, and how an entry is unwound.
 *
 * Two things this application leans on everywhere and had no test of its own
 * for. A customer handing over money rarely says which receipt it is for, so
 * the shop decides — and getting that order wrong quietly changes which
 * invoices look overdue. Reversal is the mechanism every void in the system is
 * built from; nothing else corrects anything.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH = 0;
let CUSTOMER = 0;
let PRODUCT = 0;

/** A credit sale of `units` at 10.00 each, dated `day`. */
function creditSale(day: string, units: number) {
  return createSale(
    context.db,
    {
      businessDate: day,
      customerId: CUSTOMER,
      items: [{ productId: PRODUCT, qty: u(units) }],
      tenders: [],
    },
    ACTOR,
  );
}

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  CASH = context.db
    .select()
    .from(paymentAccounts)
    .all()
    .find((account) => account.kind === 'CASH')!.id;
  CUSTOMER = createCustomer(context.db, { name: 'Ama', creditLimit: null }, ACTOR);
  PRODUCT = createProduct(
    context.db,
    { name: 'Rice', costPrice: m(500), sellingPrice: m(1_000), unit: 'bag' },
    ACTOR,
  );
  createStockAdjustment(
    context.db,
    {
      businessDate: '2026-08-01',
      reason: 'OPENING_STOCK',
      items: [{ productId: PRODUCT, direction: 'IN', qty: u(500), totalCost: m(250_000) }],
    },
    ACTOR,
  );
});

afterEach(() => context.cleanup());

describe('who a payment pays when the customer does not say', () => {
  it('settles the OLDEST invoice first', () => {
    /**
     * The order matters beyond tidiness: ageing is measured from the due date,
     * so paying the newest first would leave the oldest invoice sitting in the
     * "over 90 days" column while the customer is in fact up to date.
     */
    const august = creditSale('2026-08-05', 3); // 30.00
    const september = creditSale('2026-09-05', 3); // 30.00

    recordCustomerPayment(
      context.db,
      { customerId: CUSTOMER, businessDate: '2026-09-10', paymentAccountId: CASH, amount: m(3_000) },
      ACTOR,
    );

    expect(getSaleOutstanding(context.db, august.saleId)).toBe(0);
    expect(getSaleOutstanding(context.db, september.saleId)).toBe(3_000);
  });

  it('spills over onto the next invoice when it more than covers the first', () => {
    const first = creditSale('2026-08-05', 2); // 20.00
    const second = creditSale('2026-08-06', 5); // 50.00

    recordCustomerPayment(
      context.db,
      { customerId: CUSTOMER, businessDate: '2026-08-10', paymentAccountId: CASH, amount: m(3_000) },
      ACTOR,
    );

    expect(getSaleOutstanding(context.db, first.saleId)).toBe(0);
    expect(getSaleOutstanding(context.db, second.saleId)).toBe(4_000);

    // And it is recorded as two allocations, not one lump against a customer.
    expect(context.db.select().from(customerPaymentAllocations).all()).toHaveLength(2);
  });

  it('leaves the rest of an invoice outstanding on a part payment', () => {
    const sale = creditSale('2026-08-05', 5); // 50.00

    recordCustomerPayment(
      context.db,
      { customerId: CUSTOMER, businessDate: '2026-08-10', paymentAccountId: CASH, amount: m(2_000) },
      ACTOR,
    );

    expect(getSaleOutstanding(context.db, sale.saleId)).toBe(3_000);
    expect(getCustomerBalance(context.db, CUSTOMER)).toBe(3_000);
  });
});

describe('a payment aimed at particular invoices', () => {
  it('settles exactly the ones named, in defiance of age', () => {
    // A customer who insists on paying the newest — because that is the one
    // their own office has approved — must be able to.
    const old = creditSale('2026-08-05', 2);
    const recent = creditSale('2026-09-05', 2);

    recordCustomerPayment(
      context.db,
      {
        customerId: CUSTOMER,
        businessDate: '2026-09-10',
        paymentAccountId: CASH,
        amount: m(2_000),
        allocations: [{ saleId: recent.saleId, amount: m(2_000) }],
      },
      ACTOR,
    );

    expect(getSaleOutstanding(context.db, old.saleId)).toBe(2_000);
    expect(getSaleOutstanding(context.db, recent.saleId)).toBe(0);
  });

  it('refuses to put more on an invoice than it owes', () => {
    const sale = creditSale('2026-08-05', 2); // 20.00

    expect(() =>
      recordCustomerPayment(
        context.db,
        {
          customerId: CUSTOMER,
          businessDate: '2026-08-10',
          paymentAccountId: CASH,
          amount: m(2_000),
          allocations: [{ saleId: sale.saleId, amount: m(2_001) }],
        },
        ACTOR,
      ),
    ).toThrow(ValidationError);
  });

  it('refuses to allocate more than the payment itself', () => {
    const first = creditSale('2026-08-05', 2);
    const second = creditSale('2026-08-06', 2);

    expect(() =>
      recordCustomerPayment(
        context.db,
        {
          customerId: CUSTOMER,
          businessDate: '2026-08-10',
          paymentAccountId: CASH,
          amount: m(2_000),
          allocations: [
            { saleId: first.saleId, amount: m(2_000) },
            { saleId: second.saleId, amount: m(2_000) },
          ],
        },
        ACTOR,
      ),
    ).toThrow(ValidationError);
  });

  it('refuses an invoice belonging to somebody else', () => {
    const other = createCustomer(context.db, { name: 'Kofi', creditLimit: null }, ACTOR);
    const theirs = createSale(
      context.db,
      { businessDate: '2026-08-05', customerId: other, items: [{ productId: PRODUCT, qty: u(2) }], tenders: [] },
      ACTOR,
    );
    creditSale('2026-08-05', 2);

    expect(() =>
      recordCustomerPayment(
        context.db,
        {
          customerId: CUSTOMER,
          businessDate: '2026-08-10',
          paymentAccountId: CASH,
          amount: m(2_000),
          allocations: [{ saleId: theirs.saleId, amount: m(2_000) }],
        },
        ACTOR,
      ),
    ).toThrow(ValidationError);
  });
});

describe('reversing a journal entry', () => {
  /**
   * The mechanism every void is built from, and it had no test of its own.
   * What it must do is narrow: leave the original completely untouched, write
   * a mirror that cancels it, and link the two so either can be found from the
   * other.
   */
  const reverse = (entryId: number) =>
    writeTransaction(context.db, (tx) =>
      reverseJournalEntry(
        tx,
        entryId,
        {
          entryDate: '2026-08-11',
          memo: 'Reversed',
          // Required. A reversal defaults to `sourceType: 'REVERSAL'`, and
          // `ck_journal_entries_traceable` refuses any entry that names no
          // source unless it is an opening balance or a year-end close — so a
          // reversal has to say what it is reversing. See the test below.
          sourceId: entryId,
        },
        null,
      ),
    );

  const postOne = () =>
    writeTransaction(context.db, (tx) =>
      postJournalEntry(
        tx,
        {
          entryDate: '2026-08-10',
          memo: 'Owner puts money in',
          sourceType: 'OPENING_BALANCE',
          isOpening: true,
          lines: [
            debit(accountIdFor(context.db, '1001'), m(50_000)),
            credit(accountIdFor(context.db, ACCOUNT_CODES.OWNERS_CAPITAL), m(50_000)),
          ],
        },
        null,
      ),
    );

  it('writes a mirror that cancels the original', () => {
    const original = postOne();
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.CASH)).toBe(50_000);

    reverse(original.entryId);

    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.CASH)).toBe(0);
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });

  it('leaves the original entry exactly as it was', () => {
    const original = postOne();
    const before = context.db
      .select()
      .from(journalLines)
      .where(eq(journalLines.entryId, original.entryId))
      .all();

    reverse(original.entryId);

    const after = context.db
      .select()
      .from(journalLines)
      .where(eq(journalLines.entryId, original.entryId))
      .all();

    expect(after).toEqual(before);
  });

  it('links the two, so either can be found from the other', () => {
    const original = postOne();
    const reversal = reverse(original.entryId);

    const rows = context.db.select().from(journalEntries).all();
    const first = rows.find((row) => row.id === original.entryId)!;
    const mirror = rows.find((row) => row.id === reversal.entryId)!;

    expect(first.reversedByEntryId).toBe(mirror.id);
    expect(mirror.reversesEntryId).toBe(first.id);
  });

  it('refuses to reverse without naming what it reverses', () => {
    /**
     * `ck_journal_entries_traceable`: every entry must name the business
     * transaction it came from, and only an opening balance or a year-end
     * close is excused. A reversal that named nothing would be an amount
     * appearing in the books with no explanation.
     */
    const original = postOne();

    expect(() =>
      writeTransaction(context.db, (tx) =>
        reverseJournalEntry(tx, original.entryId, { entryDate: '2026-08-11' }, null),
      ),
    ).toThrow(/traceable/i);
  });

  it('refuses to reverse the same entry twice', () => {
    const original = postOne();
    reverse(original.entryId);

    expect(() => reverse(original.entryId)).toThrow(/already been reversed/i);
  });

  it('swaps every debit for a credit rather than negating amounts', () => {
    // A negative debit would balance arithmetically and be unreadable on a
    // statement. A reversal is an entry in its own right.
    const original = postOne();
    const reversal = reverse(original.entryId);

    const mirrored = context.db
      .select()
      .from(journalLines)
      .where(eq(journalLines.entryId, reversal.entryId))
      .all();

    expect(mirrored.every((line) => line.debitMinor >= 0 && line.creditMinor >= 0)).toBe(true);
    expect(mirrored.reduce((sum, line) => sum + line.debitMinor, 0)).toBe(50_000);
    expect(mirrored.reduce((sum, line) => sum + line.creditMinor, 0)).toBe(50_000);
  });
});
