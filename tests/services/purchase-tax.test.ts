import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, ne } from 'drizzle-orm';

import { createTestDatabase, accountIdFor, type TestDatabase } from '../helpers/test-db';
import { setGhanaTaxes, setSingleTax } from '../helpers/tax';
import { paymentAccounts, products, purchaseTaxes, taxComponents } from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { createProduct } from '@/services/catalog.service';
import { createSupplier } from '@/services/supplier.service';
import { createPurchase, voidPurchase } from '@/services/purchase.service';
import { getAccountBalanceByCode } from '@/services/reporting/balances.service';
import { getInventoryValue } from '@/services/inventory.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';

/**
 * Tax paid to a supplier.
 *
 * The distinction that matters: in Ghana, VAT paid on a purchase is set
 * against VAT collected on sales, so it is an ASSET. NHIL and GETFund are not
 * reclaimable against anything — they are part of what the goods cost. Book
 * them as reclaimable and the shop overstates what the authority owes it while
 * understating the cost of every item sold from that delivery, which quietly
 * overstates the profit on every one of them.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const DAY = '2026-08-10';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

let CASH = 0;
let SUPPLIER = 0;

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');

  CASH = context.db.select().from(paymentAccounts).all().find((a) => a.kind === 'CASH')!.id;
  SUPPLIER = createSupplier(context.db, { name: 'Kofi Wholesale' }, ACTOR);
});

afterEach(() => context.cleanup());

function riceDelivery(unitCost: number, qty: number, paid: number): number {
  const rice = createProduct(
    context.db,
    { name: 'Rice 5kg', costPrice: m(unitCost), sellingPrice: m(10_000), unit: 'bag' },
    ACTOR,
  );

  createPurchase(
    context.db,
    {
      businessDate: DAY,
      supplierId: SUPPLIER,
      items: [{ productId: rice, qty: u(qty), unitCost: m(unitCost) }],
      tenders: [{ paymentAccountId: CASH, amount: m(paid) }],
    },
    ACTOR,
  );

  return rice;
}

/**
 * Make the levies NON-recoverable, as they were before Act 1151.
 *
 * The tests below are about the MECHANISM — tax that cannot be reclaimed is
 * part of what the goods cost — not about what Ghana charges this year. Ghana's
 * own defaults moved on 1 January 2026; the mechanism did not, and still has to
 * work for an importer, or for any shop whose position differs.
 */
function levyIsACost(db: TestDatabase['db']): void {
  db.update(taxComponents)
    .set({ isRecoverable: false })
    .where(ne(taxComponents.code, 'VAT'))
    .run();
}

describe('tax on a delivery that cannot be reclaimed', () => {
  it('puts it into what the goods cost, and reclaims only what it may', () => {
    setGhanaTaxes(context.db);
    levyIsACost(context.db);

    // 10 bags at GHS 65.00 = GHS 650.00 net.
    // NHIL 16.25, GETFund 16.25, VAT 97.50. Total paid: GHS 780.00.
    riceDelivery(6_500, 10, 78_000);

    const recorded = context.db.select().from(purchaseTaxes).all();
    expect(recorded.map((row) => [row.code, row.amountMinor, row.isRecoverable])).toEqual([
      ['NHIL', 1_625, false],
      ['GETFUND', 1_625, false],
      ['VAT', 9_750, true],
    ]);

    // The stock is worth the goods plus the two levies: 650.00 + 32.50.
    expect(getInventoryValue(context.db), 'stock value').toBe(68_250);
    expect(
      getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY),
      'Inventory account agrees with the shelf',
    ).toBe(68_250);

    // Only the VAT is an asset against the authority.
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.TAX_PAYABLE)).toBe(-9_750);

    // The levy accounts are for tax COLLECTED. A purchase never touches them.
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.NHIL_PAYABLE)).toBe(0);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.GETFUND_PAYABLE)).toBe(0);
  });

  it('carries it into the unit cost, so margin is not overstated', () => {
    setGhanaTaxes(context.db);
    levyIsACost(context.db);
    const rice = riceDelivery(6_500, 10, 78_000);

    const product = context.db.select().from(products).where(eq(products.id, rice)).get()!;

    // GHS 682.50 across 10 bags: each bag really cost 68.25, not 65.00.
    // Priced from 65.00, every sale would look GHS 3.25 more profitable than it is.
    expect(product.stockValueMinor).toBe(68_250);
    expect(product.qtyOnHandMilli).toBe(10_000);
  });

  it('reclaims the whole tax when every component is reclaimable', () => {
    // Which, since Act 1151, is Ghana's own position on domestic supplies —
    // see the dedicated case below.
    setSingleTax(context.db, { rateBp: 1_250 });
    riceDelivery(6_500, 10, 73_125);

    expect(getInventoryValue(context.db), 'stock is the goods value alone').toBe(65_000);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.TAX_PAYABLE)).toBe(-8_125);
  });

  it('adds nothing at all when the shop is not registered for tax', () => {
    riceDelivery(6_500, 10, 65_000);

    expect(context.db.select().from(purchaseTaxes).all()).toHaveLength(0);
    expect(getInventoryValue(context.db)).toBe(65_000);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.TAX_PAYABLE)).toBe(0);
  });
});

describe('Ghana from 1 January 2026, as the shop is seeded', () => {
  /**
   * The Value Added Tax Act, 2025 (Act 1151) made the invoice amount the tax
   * base for the levies as well as for VAT, and allowed NHIL and GETFund as
   * input tax on qualifying domestic supplies. Before it, they were a cost of
   * the goods and only VAT could be reclaimed.
   *
   * The change is one column on three seeded rows, which is the point: the shop
   * did not wait for a release, and neither did anybody who had already edited
   * their own rates.
   */
  it('reclaims all three, so nothing lands in the cost of the goods', () => {
    setGhanaTaxes(context.db);

    // 10 bags at GHS 65.00 = GHS 650.00 net.
    // NHIL 16.25 + GETFund 16.25 + VAT 97.50 = GHS 130.00, all reclaimable.
    riceDelivery(6_500, 10, 78_000);

    expect(
      context.db.select().from(purchaseTaxes).all().map((row) => [row.code, row.isRecoverable]),
    ).toEqual([
      ['NHIL', true],
      ['GETFUND', true],
      ['VAT', true],
    ]);

    // The shelf is worth the goods and nothing else.
    expect(getInventoryValue(context.db), 'stock is the goods alone').toBe(65_000);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY)).toBe(65_000);

    // Each levy is an asset against the authority, in its OWN account — which
    // is why they were never netted into one.
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.NHIL_PAYABLE)).toBe(-1_625);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.GETFUND_PAYABLE)).toBe(-1_625);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.TAX_PAYABLE)).toBe(-9_750);
  });

  it('charges 20 per cent on the net, not 20.75 on a cascade', () => {
    // Act 1151 removed the tax-on-tax: all three sit on the invoice amount.
    // The old treatment charged VAT on net + levies and came to 20.75%.
    setGhanaTaxes(context.db);
    riceDelivery(6_500, 10, 78_000);

    const total = context.db
      .select()
      .from(purchaseTaxes)
      .all()
      .reduce((sum, row) => sum + row.amountMinor, 0);

    expect(total, 'GHS 130.00 on GHS 650.00').toBe(13_000);
  });
});

describe('voiding a delivery that carried tax', () => {
  it('stops reclaiming the VAT, and takes the levies back out of stock', () => {
    levyIsACost(context.db);
    setGhanaTaxes(context.db);
    riceDelivery(6_500, 10, 78_000);

    const purchaseId = context.connection
      .prepare("SELECT id FROM purchases WHERE kind = 'PURCHASE'")
      .get() as { id: number };

    voidPurchase(context.db, purchaseId.id, 'Wrong supplier invoice', ACTOR);

    // Nothing left on the shelf, nothing left to reclaim, nothing owed.
    expect(getInventoryValue(context.db)).toBe(0);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY)).toBe(0);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.TAX_PAYABLE)).toBe(0);

    // The mirror rows are there, so a tax return reading these nets to zero.
    const net = context.db
      .select()
      .from(purchaseTaxes)
      .all()
      .reduce((running, row) => running + row.amountMinor, 0);
    expect(net, 'what was reclaimed, less what was given back').toBe(0);
  });
});

describe('the account a purchase reclaims into', () => {
  it('follows the component, not a hard-coded tax account', () => {
    /**
     * A shop that holds its VAT somewhere other than 2100 must have its
     * purchases reclaim there too, or the account it files from is short by
     * everything it ever bought.
     */
    setSingleTax(context.db, { rateBp: 1_250 });
    context.connection
      .prepare("UPDATE tax_components SET gl_account_id = ? WHERE code = 'VAT'")
      .run(accountIdFor(context.db, ACCOUNT_CODES.NHIL_PAYABLE));

    riceDelivery(6_500, 10, 73_125);

    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.NHIL_PAYABLE)).toBe(-8_125);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.TAX_PAYABLE)).toBe(0);
  });
});
