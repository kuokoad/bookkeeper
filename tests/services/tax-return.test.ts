import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ne } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { paymentAccounts, purchaseTaxes, taxComponents } from '@/db/schema';
import { setGhanaTaxes } from '../helpers/tax';
import { thisMonth } from '../helpers/clock';
import { createProduct } from '@/services/catalog.service';
import { createSupplier } from '@/services/supplier.service';
import { createPurchase, voidPurchase } from '@/services/purchase.service';
import { createSale, voidSale } from '@/services/sale.service';
import {
  createCustomerReturn,
  createSupplierReturn,
  getReturnablePurchaseItems,
  getReturnableSaleItems,
} from '@/services/returns.service';
import { getTaxReturn } from '@/services/reporting/tax-return.service';
import { getAccountBalanceByCode, getTrialBalance } from '@/services/reporting/balances.service';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * What the shop hands to the GRA.
 *
 * Ghana charges three taxes on one sale and they are three separate
 * obligations, so this reports each separately — a single "tax" figure cannot
 * be filed. Every number here has to be defensible line by line, because the
 * person carrying it to the tax office is the one who answers for it.
 *
 * The hard cases are all about time. A sale cancelled next month is not
 * un-declared this month; it is adjusted next month. Tax that was not
 * reclaimable when the goods were bought does not become reclaimable because
 * the law changed afterwards. Both are tested here, because both are the kind
 * of mistake that produces a return which balances perfectly and is wrong.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const AUGUST = { from: '2026-08-01', to: '2026-08-31' };
const SEPTEMBER = { from: '2026-09-01', to: '2026-09-30' };
/* Where a cancellation lands: the month the suite is running in, not a
   literal. See tests/helpers/clock.ts. */
const THIS_MONTH = thisMonth();

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH = 0;
let SUPPLIER = 0;

/**
 * Ghana's three, as the seed ships them from 1 January 2026.
 *
 * `leviesRecoverable: false` is what the law said BEFORE Act 1151 — the state
 * every existing shop's older purchases were bought under.
 */
function ghanaTaxes(options: { leviesRecoverable?: boolean } = {}): void {
  setGhanaTaxes(context.db);
  if (options.leviesRecoverable === false) {
    context.db
      .update(taxComponents)
      .set({ isRecoverable: false })
      .where(ne(taxComponents.code, 'VAT'))
      .run();
  } else {
    context.db.update(taxComponents).set({ isRecoverable: true }).run();
  }
}

function makeProduct(): number {
  return createProduct(
    context.db,
    { name: 'Rice 5kg', costPrice: m(1_000), sellingPrice: m(2_000), unit: 'bag' },
    ACTOR,
  );
}

function buy(productId: number, businessDate: string, qtyUnits = 10, unitCost = 1_000) {
  return createPurchase(
    context.db,
    {
      businessDate,
      supplierId: SUPPLIER,
      items: [{ productId, qty: u(qtyUnits), unitCost: m(unitCost) }],
      tenders: [{ paymentAccountId: CASH, amount: m(0) }],
    },
    ACTOR,
  );
}

/**
 * A cash sale, paid in full.
 *
 * The total is worked out here rather than guessed: 20.00 a bag, plus the three
 * taxes at 2.5 + 2.5 + 15 per cent of the net. Leaving it unpaid would make
 * these tests about the credit-limit rules instead of about tax.
 */
function sell(productId: number, businessDate: string, qtyUnits = 2) {
  const net = qtyUnits * 2_000;
  const tax = Math.round(net * 0.2);

  return createSale(
    context.db,
    {
      businessDate,
      items: [{ productId, qty: u(qtyUnits) }],
      tenders: [{ paymentAccountId: CASH, amount: m(net + tax) }],
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
  SUPPLIER = createSupplier(context.db, { name: 'Kofi Wholesale' }, ACTOR);
  ghanaTaxes();
});

afterEach(() => context.cleanup());

describe('the three taxes, kept apart', () => {
  it('reports each component separately rather than as one figure', () => {
    const rice = makeProduct();
    buy(rice, '2026-08-05');
    sell(rice, '2026-08-10');

    const period = getTaxReturn(context.db, AUGUST);

    expect(period.components.map((row) => row.code).sort()).toEqual([
      'GETFUND',
      'NHIL',
      'VAT',
    ]);
    // 2 bags at 20.00 = 40.00 net. NHIL and GETFund at 2.5%, VAT at 15%.
    const byCode = new Map(period.components.map((row) => [row.code, row]));
    expect(byCode.get('NHIL')!.outputMinor).toBe(100);
    expect(byCode.get('GETFUND')!.outputMinor).toBe(100);
    expect(byCode.get('VAT')!.outputMinor).toBe(600);
  });

  it('nets recoverable input tax off the output, component by component', () => {
    const rice = makeProduct();
    buy(rice, '2026-08-05'); // 10 bags at 10.00 = 100.00 net
    sell(rice, '2026-08-10'); // 2 bags at 20.00 = 40.00 net

    const byCode = new Map(
      getTaxReturn(context.db, AUGUST).components.map((row) => [row.code, row]),
    );

    // VAT: charged 6.00, paid 15.00, so 9.00 is reclaimable this month.
    expect(byCode.get('VAT')!.outputMinor).toBe(600);
    expect(byCode.get('VAT')!.recoverableInputMinor).toBe(1_500);
    expect(byCode.get('VAT')!.netMinor).toBe(-900);
  });

  it('adds up to what is owed, or what is owed back', () => {
    const rice = makeProduct();
    buy(rice, '2026-08-05');
    sell(rice, '2026-08-10');

    const period = getTaxReturn(context.db, AUGUST);
    expect(period.totalOutput).toBe(800);
    expect(period.totalRecoverableInput).toBe(2_000);
    expect(period.netPayable).toBe(-1_200);
    expect(period.netPayable).toBe(period.totalOutput - period.totalRecoverableInput);
  });

  it('says what the tax was charged on, which the return form asks for', () => {
    const rice = makeProduct();
    buy(rice, '2026-08-05');
    sell(rice, '2026-08-10');

    const period = getTaxReturn(context.db, AUGUST);
    expect(period.taxableSalesMinor).toBe(4_000);
    expect(period.taxablePurchasesMinor).toBe(10_000);
    expect(period.saleCount).toBe(1);
    expect(period.purchaseCount).toBe(1);
  });
});

describe('tax that was never reclaimable', () => {
  it('is reported, not quietly dropped', () => {
    /**
     * Before 1 January 2026 the levies could not be reclaimed: they went into
     * the cost of the goods and out through cost of sales. An owner who cannot
     * see them will wonder why the return does not match what the shop paid.
     */
    ghanaTaxes({ leviesRecoverable: false });

    const rice = makeProduct();
    buy(rice, '2026-08-05');

    const byCode = new Map(
      getTaxReturn(context.db, AUGUST).components.map((row) => [row.code, row]),
    );

    expect(byCode.get('NHIL')!.recoverableInputMinor).toBe(0);
    expect(byCode.get('NHIL')!.nonRecoverableInputMinor).toBe(250);
    expect(byCode.get('VAT')!.recoverableInputMinor).toBe(1_500);
  });

  it('never reclaims it, however the setting is changed afterwards', () => {
    // The law is not retrospective, and neither is this: what could be
    // reclaimed is a fact about the day the goods were bought, snapshotted on
    // the row.
    ghanaTaxes({ leviesRecoverable: false });
    const rice = makeProduct();
    buy(rice, '2026-08-05');

    ghanaTaxes({ leviesRecoverable: true });

    const byCode = new Map(
      getTaxReturn(context.db, AUGUST).components.map((row) => [row.code, row]),
    );
    expect(byCode.get('NHIL')!.recoverableInputMinor).toBe(0);
    expect(byCode.get('NHIL')!.nonRecoverableInputMinor).toBe(250);
  });
});

describe('goods that come back', () => {
  it('takes the tax off a customer return', () => {
    const rice = makeProduct();
    buy(rice, '2026-08-05');
    const sale = sell(rice, '2026-08-10', 2);

    const items = getReturnableSaleItems(context.db, sale.saleId);
    createCustomerReturn(
      context.db,
      sale.saleId,
      {
        businessDate: '2026-08-12',
        items: [{ itemId: items[0]!.id, qty: u(1) }],
        // Paid in full at the till, so it comes back as a refund, not a credit.
        refunds: [{ paymentAccountId: CASH, amount: m(2_400) }],
      },
      ACTOR,
    );

    const byCode = new Map(
      getTaxReturn(context.db, AUGUST).components.map((row) => [row.code, row]),
    );
    // Half the sale came back, so half the output tax goes with it.
    expect(byCode.get('VAT')!.outputMinor).toBe(300);
  });

  it('STOPS reclaiming tax on goods sent back to the supplier', () => {
    /**
     * This was wrong until the return report was built, and nothing could have
     * noticed. The total was mirrored onto the return document, so the trial
     * balance and every other report agreed — but the per-component rows were
     * never written, and those are the only rows a tax return reads. The shop
     * would have gone on reclaiming input tax on goods it no longer had.
     */
    const rice = makeProduct();
    const purchase = buy(rice, '2026-08-05', 10, 1_000);

    const items = getReturnablePurchaseItems(context.db, purchase.purchaseId);
    createSupplierReturn(
      context.db,
      purchase.purchaseId,
      { businessDate: '2026-08-08', items: [{ itemId: items[0]!.id, qty: u(4) }] },
      ACTOR,
    );

    const byCode = new Map(
      getTaxReturn(context.db, AUGUST).components.map((row) => [row.code, row]),
    );

    // 4 of 10 bags went back, so 40% of the input tax goes with them.
    expect(byCode.get('VAT')!.recoverableInputMinor).toBe(900);
    expect(byCode.get('NHIL')!.recoverableInputMinor).toBe(150);

    // And the rows really exist, rather than the figure being derived.
    const rows = context.db.select().from(purchaseTaxes).all();
    expect(rows.filter((row) => row.amountMinor < 0)).toHaveLength(3);
  });

  it('carries the original recoverability onto the return, not today’s', () => {
    ghanaTaxes({ leviesRecoverable: false });
    const rice = makeProduct();
    const purchase = buy(rice, '2026-08-05');

    ghanaTaxes({ leviesRecoverable: true });

    const items = getReturnablePurchaseItems(context.db, purchase.purchaseId);
    createSupplierReturn(
      context.db,
      purchase.purchaseId,
      { businessDate: '2026-08-08', items: [{ itemId: items[0]!.id, qty: u(10) }] },
      ACTOR,
    );

    const byCode = new Map(
      getTaxReturn(context.db, AUGUST).components.map((row) => [row.code, row]),
    );
    // Everything went back. Both sides were non-recoverable, so both cancel and
    // nothing appears as reclaimable in either direction.
    expect(byCode.get('NHIL')!.recoverableInputMinor).toBe(0);
    expect(byCode.get('NHIL')!.nonRecoverableInputMinor).toBe(0);
  });
});

describe('a sale cancelled in a later month', () => {
  /**
   * The rule that decides the whole shape of this report.
   *
   * A void is dated the day it is made, never the day of the sale — so a sale
   * from a filed period and its cancellation fall in different returns. Tax
   * already declared cannot be un-declared; it is adjusted where the
   * cancellation happened. Filter out `status = 'VOIDED'` and the original
   * disappears while its mirror remains, turning a cancelled sale into a
   * negative liability in a month it had nothing to do with.
   */
  const JULY = { from: '2026-07-01', to: '2026-07-31' };

  it('stays declared in the month it was made', () => {
    const rice = makeProduct();
    buy(rice, '2026-07-05');
    const sale = sell(rice, '2026-07-10');

    expect(getTaxReturn(context.db, JULY).totalOutput).toBe(800);

    // Cancelled now — which is a later month than the sale.
    voidSale(context.db, sale.saleId, 'Rang it up twice', ACTOR);

    // July still says what July said. The shop filed that figure.
    expect(getTaxReturn(context.db, JULY).totalOutput).toBe(800);
  });

  it('shows the adjustment in the month it was cancelled', () => {
    const rice = makeProduct();
    buy(rice, '2026-07-05');
    const sale = sell(rice, '2026-07-10');
    voidSale(context.db, sale.saleId, 'Rang it up twice', ACTOR);

    // The mirror is dated today, so it lands in the CURRENT month, not July.
    expect(getTaxReturn(context.db, THIS_MONTH).totalOutput).toBe(-800);

    // ...and July is not where it landed. Without this, widening the window
    // above to something that happened to contain both dates would pass.
    expect(getTaxReturn(context.db, JULY).totalOutput).toBe(800);

    // And across all time the pair nets to nothing, as a cancelled sale must.
    const wide = getTaxReturn(context.db, { from: '2026-01-01', to: '2099-12-31' });
    expect(wide.totalOutput).toBe(0);
  });

  it('nets a voided purchase back out of the reclaim', () => {
    const rice = makeProduct();
    const purchase = buy(rice, '2026-08-05');
    expect(getTaxReturn(context.db, AUGUST).totalRecoverableInput).toBe(2_000);

    voidPurchase(context.db, purchase.purchaseId, 'Invoiced twice', ACTOR);

    const wide = getTaxReturn(context.db, { from: '2026-01-01', to: '2099-12-31' });
    expect(wide.totalRecoverableInput).toBe(0);
  });
});

describe('what the return says against what the books say', () => {
  it('agrees with the tax accounts in the general ledger', () => {
    /**
     * Two counts of the same obligation: this report, and the GL accounts the
     * tax was posted to. They are meant to be two views of one fact, and a
     * shop cannot tell which is right when they disagree.
     */
    const rice = makeProduct();
    buy(rice, '2026-08-05');
    sell(rice, '2026-08-10');

    const wide = getTaxReturn(context.db, { from: '2026-01-01', to: '2099-12-31' });

    // VAT posts to its own account. `getAccountBalanceByCode` reports a
    // liability credit-positive, so tax owed is positive and tax reclaimable is
    // negative — the same convention `netMinor` uses, and they must agree
    // exactly rather than merely in magnitude.
    const vatBalance = getAccountBalanceByCode(context.db, ACCOUNT_CODES.TAX_PAYABLE);
    const byCode = new Map(wide.components.map((row) => [row.code, row]));

    expect(vatBalance).toBe(byCode.get('VAT')!.netMinor);
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });

  it('returns an empty return rather than nothing for a quiet month', () => {
    const period = getTaxReturn(context.db, SEPTEMBER);
    expect(period.components).toEqual([]);
    expect(period.netPayable).toBe(0);
    expect(period.saleCount).toBe(0);
  });
});
