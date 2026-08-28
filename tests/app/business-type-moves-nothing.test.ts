import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asc } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { paymentAccounts, productBatches, products } from '@/db/schema';
import { writeTransaction } from '@/db/transaction';
import { createProduct, getExpirySummary, hasDatedStock } from '@/services/catalog.service';
import { createSale } from '@/services/sale.service';
import { recordStockMovement } from '@/services/inventory.service';
import { getTrialBalance } from '@/services/reporting/balances.service';
import { getBalanceSheet, getProfitAndLoss } from '@/services/reporting/financial.service';
import { getSettings, updateSettings, type SettingsInput } from '@/services/settings.service';
import { featuresFromRow } from '@/lib/business-type';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * The one rule the whole feature rests on.
 *
 * A business type decides what a shop is OFFERED. It must never decide what the
 * shop's books say. Switching from a provision shop to a building materials
 * yard and back puts menu entries away and brings them out again; if it moves a
 * single figure by a single pesewa, the setting is not a preference any more,
 * it is a way to misstate the accounts — and nobody would go looking for it,
 * because nothing on screen would suggest a total had changed.
 *
 * Written the way `tests/services/sales-filters.test.ts` asserts that filtering
 * writes nothing: snapshot everything that could move, do the thing, compare.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-08-25';
const SOON = '2026-09-10';
const PERIOD = { from: '2026-08-01', to: '2026-08-31' };

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH = 0;

function currentAsInput(): SettingsInput {
  const settings = getSettings(context.db);
  return {
    businessName: settings.businessName,
    tagline: settings.tagline,
    address: settings.address,
    phone: settings.phone,
    email: settings.email,
    currencyCode: settings.currencyCode,
    currencySymbol: settings.currencySymbol,
    look: settings.look,
    businessType: settings.businessType,
    features: featuresFromRow(settings),
    taxEnabled: settings.taxEnabled,
    taxInclusive: settings.taxInclusive,
    lowStockThresholdMilli: settings.lowStockThresholdMilli,
    allowNegativeStock: settings.allowNegativeStock,
    expiryWarningDays: settings.expiryWarningDays,
    expiryBlocksSales: settings.expiryBlocksSales,
    allowOverpayment: settings.allowOverpayment,
    defaultTermsDays: settings.defaultTermsDays,
    financialYearStartMonth: settings.financialYearStartMonth,
  };
}

const count = (table: string): number =>
  (context.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Everything a shop owner could look at and notice had changed. */
function snapshot() {
  return {
    stock: context.db
      .select({ id: products.id, qty: products.qtyOnHandMilli, value: products.stockValueMinor })
      .from(products)
      .orderBy(asc(products.id))
      .all(),
    batches: context.db
      .select({
        id: productBatches.id,
        qty: productBatches.qtyMilli,
        expiry: productBatches.expiryDate,
        closed: productBatches.isClosed,
      })
      .from(productBatches)
      .orderBy(asc(productBatches.id))
      .all(),
    sales: count('sales'),
    saleItems: count('sale_items'),
    entries: count('journal_entries'),
    lines: count('journal_lines'),
    ledger: count('stock_ledger'),
    ledgerBatches: count('stock_ledger_batches'),
    trial: getTrialBalance(context.db),
    profitAndLoss: getProfitAndLoss(context.db, PERIOD),
    balanceSheet: getBalanceSheet(context.db, TODAY),
    expiry: getExpirySummary(context.db, TODAY),
    // The two the till reads. A menu setting must not reach either.
    expiryWarningDays: getSettings(context.db).expiryWarningDays,
    expiryBlocksSales: getSettings(context.db).expiryBlocksSales,
  };
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

  // A shop with real history AND dated stock, so there is something for a
  // change of type to damage if it were going to.
  const milk = createProduct(
    context.db,
    { name: 'Evaporated Milk', costPrice: m(300), sellingPrice: m(500), unit: 'tin' },
    ACTOR,
  );
  writeTransaction(context.db, (tx) =>
    recordStockMovement(tx, {
      productId: milk,
      direction: 'IN',
      qty: u(40),
      totalCost: m(12_000),
      movementType: 'PURCHASE',
      sourceType: 'TEST',
      businessDate: TODAY,
      occurredAt: new Date(`${TODAY}T08:00:00Z`),
      batch: { kind: 'NEW', expiryDate: SOON },
    }),
  );
  createSale(
    context.db,
    {
      businessDate: TODAY,
      items: [{ productId: milk, qty: u(6) }],
      tenders: [{ paymentAccountId: CASH, amount: m(3_000) }],
    },
    ACTOR,
  );
});

afterEach(() => context.cleanup());

describe('changing what kind of business this is', () => {
  it('moves no figure, whichever type is chosen', () => {
    const before = snapshot();

    for (const businessType of ['building_materials', 'other', 'general_retail'] as const) {
      updateSettings(context.db, { ...currentAsInput(), businessType }, ACTOR);
      expect(snapshot(), `after choosing ${businessType}`).toEqual(before);
    }
  });

  it('moves no figure when a single switch is turned off', () => {
    const before = snapshot();

    updateSettings(
      context.db,
      { ...currentAsInput(), features: { expiry_batches: false } },
      ACTOR,
    );
    expect(getSettings(context.db).featureExpiryBatches).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  it('leaves the stock that carries a date exactly where it was', () => {
    updateSettings(context.db, { ...currentAsInput(), businessType: 'building_materials' }, ACTOR);

    const batches = context.db.select().from(productBatches).all();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.expiryDate).toBe(SOON);
    expect(batches[0]!.qtyMilli).toBe(34_000);
  });

  /**
   * The reason the expiry settings stay on screen for a yard that has dated
   * something: the till still refuses that stock, so the switch that does it
   * must still be reachable.
   */
  it('leaves the till reading exactly what it read before', () => {
    updateSettings(context.db, { ...currentAsInput(), businessType: 'building_materials' }, ACTOR);

    const settings = getSettings(context.db);
    expect(settings.expiryBlocksSales).toBe(true);
    expect(settings.expiryWarningDays).toBe(30);
    expect(hasDatedStock(context.db)).toBe(true);
  });
});
