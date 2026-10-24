import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { journalEntries, products, stockAdjustments, stockLedger, units } from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { minor } from '@/domain/money';
import { ValidationError } from '@/domain/errors';
import { createCategory, createProduct } from '@/services/catalog.service';
import { verifyProductStock } from '@/services/inventory.service';
import {
  guessColumns,
  importProducts,
  previewProductImport,
  TEMPLATE_HEADINGS,
} from '@/services/product-import.service';
import { getAccountBalanceByCode } from '@/services/reporting/balances.service';
import { checkBooksIntegrity } from '@/services/reporting/ledger.service';
import { IMPORT_FIELDS } from '@/lib/product-import-fields';

/**
 * Importing a supplier price list, shaped like the shop's own JCG sheet: two
 * columns headed "cost price", per-piece costs that are formula output, prices
 * given per pack only, and a hundred empty formatted rows at the bottom.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const TODAY = '2026-10-24';

const SHEET: string[][] = [
  ['PRODUCT', 'PRODUCT CODE', 'cost price', '', 'COST PRICE  ', 'PIECES PER PACK', 'COST PER PACK', 'SELLING PRICE PER PACK'],
  ['KRAFTED BOWL 750ML', 'JCG-KB-RD750', '2', '200', '400', '50', '100', '120'],
  ['KRAFTED BOWL RECTANGULAR 1000ML', 'JCG-KB-R1000', '1.7592592592592591', '900', '1583.33', '50', '87.962962962962948', '130'],
  ['', '', '', '', '', '', '', ''],
  ['LUXURY PAPER BAGS', '', '', '', '', '', '', ''],
  ['POLYMAILERS  25*35', 'JCG-KB-RD750', '0.17592592592592593', '4500', '791.67', '100', '17.59', '60'],
  // The cost formulas, filled down past the end of the list.
  ['', '', '', '', '0', '', '0', ''],
  ['', '', '', '', '0', '', '0', ''],
];

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
});
afterEach(() => context.cleanup());

const map = () => guessColumns(SHEET[0]!);

describe('product import preview', () => {
  it('takes the first "cost price" column and warns that two share the heading', () => {
    expect(map()).toMatchObject({ name: 0, sku: 1, costPrice: 2, altFactor: 5, altCostPrice: 6, altSellingPrice: 7 });
    const preview = previewProductImport(context.db, SHEET, map(), 'pack');
    expect(preview.warnings).toEqual([
      'Columns C and E are both headed "COST PRICE". Check the right one is chosen below.',
      '2 rows have figures but no name or code, and will be left out.',
    ]);
  });

  it('rounds formula costs to the pesewa and says so, and works out the piece price from the pack price', () => {
    const [bowl, rectangular] = previewProductImport(context.db, SHEET, map(), 'pack').rows;

    expect(bowl).toMatchObject({ line: 2, costPrice: 200, sellingPrice: 240, altFactor: 50_000, altSellingPrice: 12_000 });
    expect(bowl!.notes).toEqual(['Selling price worked out from the pack price: 2.40']);

    expect(rectangular!.costPrice).toBe(176);
    expect(rectangular!.altCostPrice).toBe(8_796);
    expect(rectangular!.notes).toContain('Cost price 1.7592… rounded to 1.76');
  });

  it('leaves out blank and nameless rows, and skips a row with no price or a repeated code with the reason', () => {
    const preview = previewProductImport(context.db, SHEET, map(), 'pack');
    expect(preview.rows.map((row) => row.line)).toEqual([2, 3, 5, 6]);
    expect(preview.rows.find((row) => row.line === 5)!.problems).toEqual(['No selling price.']);
    expect(preview.rows.find((row) => row.line === 6)!.problems).toEqual(['Code JCG-KB-RD750 is also on row 2.']);
    expect(preview).toMatchObject({ ready: 2, skipped: 2, newUnits: ['pack'] });
  });

  it('skips a code that an existing product already uses', () => {
    createProduct(context.db, { name: 'Old bowl', sku: 'jcg-kb-r1000', costPrice: minor(0), sellingPrice: minor(100) }, ACTOR);
    const rows = previewProductImport(context.db, SHEET, map(), 'pack').rows;
    expect(rows.find((row) => row.line === 3)!.problems).toEqual(['Code JCG-KB-R1000 is already used by a product.']);
  });

  it('writes nothing', () => {
    previewProductImport(context.db, SHEET, map(), 'pack');
    expect(context.db.select().from(products).all()).toHaveLength(0);
    expect(context.db.select().from(units).all().some((unit) => unit.symbol === 'pack')).toBe(false);
  });
  it('marks a negative price as a problem, not a row that fails at import', () => {
    const sheet = [['name', 'selling price', 'cost price'], ['Refund line', '5', '(2.00)']];
    const [row] = previewProductImport(context.db, sheet, guessColumns(sheet[0]!), 'pack').rows;
    expect(row!.problems).toEqual(['Cost price: "(2.00)" is negative.']);
  });
});

describe('importing products', () => {
  it('creates the ready rows with their pack unit and no stock, and skips the rest', () => {
    expect(importProducts(context.db, SHEET, map(), 'pack', TODAY, ACTOR)).toEqual({ created: 2, adjustmentNo: null });

    const created = context.db.select().from(products).all();
    expect(created.map((p) => [p.name, p.sku, p.unit, p.altUnit, p.altFactorMilli, p.costPriceMinor, p.sellingPriceMinor])).toEqual([
      ['KRAFTED BOWL 750ML', 'JCG-KB-RD750', 'pcs', 'pack', 50_000, 200, 240],
      ['KRAFTED BOWL RECTANGULAR 1000ML', 'JCG-KB-R1000', 'pcs', 'pack', 50_000, 176, 260],
    ]);
    expect(created.every((p) => p.qtyOnHandMilli === 0 && p.stockValueMinor === 0)).toBe(true);
    expect(context.db.select().from(stockLedger).all()).toHaveLength(0);
  });

  it('re-checks on import, so a code taken since the preview cannot slip in twice', () => {
    importProducts(context.db, SHEET, map(), 'pack', TODAY, ACTOR);
    // Same file again: every code is now taken, so nothing is ready.
    expect(() => importProducts(context.db, SHEET, map(), 'pack', TODAY, ACTOR)).toThrow(ValidationError);
    expect(context.db.select().from(products).all()).toHaveLength(2);
  });

  it('lands whole or not at all', () => {
    // The second insert fails inside the transaction; the first must not stay behind.
    context.connection.exec(
      "CREATE TRIGGER refuse_bag BEFORE INSERT ON products WHEN NEW.name = 'Bag' BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const sheet = [['name', 'selling price'], ['Tin', '5'], ['Bag', '6']];
    expect(() => importProducts(context.db, sheet, guessColumns(sheet[0]!), 'pack', TODAY, ACTOR)).toThrow('disk full');
    expect(context.db.select().from(products).all()).toHaveLength(0);
  });
});

describe('importing opening stock', () => {
  const HEAD = ['Product name', 'Unit', 'Cost price', 'Selling price', 'Category', 'Track stock', 'Opening quantity', 'Opening value'];
  const sheet = (...rows: string[][]) => [HEAD, ...rows];
  const run = (rows: string[][]) => importProducts(context.db, rows, guessColumns(rows[0]!), 'pack', TODAY, ACTOR);

  it('the template headings are all recognised, one field each', () => {
    const guessed = guessColumns(TEMPLATE_HEADINGS);
    expect(Object.keys(guessed).sort()).toEqual(IMPORT_FIELDS.map(({ key }) => key).sort());
  });

  it('puts opening stock through one opening adjustment, with the books balanced', () => {
    const result = run(
      sheet(
        ['Milo 400g', '', '35.00', '45.00', '', '', '48', '1680.00'],
        // No value given: quantity times cost price, 2.5 kg x 12.50 = 31.25.
        ['Rice', 'kg', '12.50', '15.00', '', '', '2.5', ''],
        ['Sugar', '', '8.00', '10.00', '', '', '', ''],
      ),
    );

    expect(result.created).toBe(3);
    expect(result.adjustmentNo).not.toBeNull();
    const adjustments = context.db.select().from(stockAdjustments).all();
    expect(adjustments.map((a) => [a.reason, a.businessDate])).toEqual([['OPENING_STOCK', TODAY]]);
    expect(context.db.select().from(journalEntries).all()).toHaveLength(1);
    expect(context.db.select().from(stockLedger).all()).toHaveLength(2);

    const byName = new Map(context.db.select().from(products).all().map((p) => [p.name, p]));
    expect(byName.get('Milo 400g')).toMatchObject({ qtyOnHandMilli: 48_000, stockValueMinor: 168_000 });
    expect(byName.get('Rice')).toMatchObject({ qtyOnHandMilli: 2_500, stockValueMinor: 3_125 });
    expect(byName.get('Sugar')).toMatchObject({ qtyOnHandMilli: 0, stockValueMinor: 0 });
    for (const product of byName.values()) expect(verifyProductStock(context.db, product.id).ok).toBe(true);

    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY)).toBe(171_125);
    expect(checkBooksIntegrity(context.db).trialBalanced).toBe(true);
  });

  it('shows the opening stock and its total in the preview before anything is written', () => {
    const rows = sheet(['Rice', 'kg', '12.50', '15.00', '', '', '2.5', ''], ['Milo', '', '35', '45', '', '', '2', '70']);
    const preview = previewProductImport(context.db, rows, guessColumns(rows[0]!), 'pack');
    expect(preview.rows[0]).toMatchObject({ openingQty: 2_500, openingValue: 3_125 });
    expect(preview.rows[0]!.notes).toContain('Opening stock valued at cost: 31.25');
    expect(preview.openingValue).toBe(10_125);
    expect(context.db.select().from(stockLedger).all()).toHaveLength(0);
  });

  it('skips opening stock it cannot value or count honestly, with the reason', () => {
    const rows = sheet(
      ['Soap', 'pcs', '1.00', '2.00', '', '', '1.5', ''],
      ['Bread', '', '5.00', '6.00', '', 'no', '10', ''],
      ['Tin', '', '', '6.00', '', '', '10', ''],
      ['Ghost', '', '1.00', '2.00', '', '', '', '50.00'],
      ['Minus', '', '1.00', '2.00', '', '', '-3', ''],
      ['Maybe', '', '1.00', '2.00', '', 'sometimes', '', ''],
    );
    const preview = previewProductImport(context.db, rows, guessColumns(rows[0]!), 'pack');
    expect(preview.rows.map((row) => row.problems)).toEqual([
      ['Opening quantity: pcs is counted in whole numbers, and 1.5 is not one.'],
      ['Only a product whose stock is tracked can have opening stock.'],
      ['Opening stock needs a cost price or an opening value.'],
      ['Opening value needs the opening quantity it is for.'],
      ['Opening quantity cannot be negative.'],
      ['Track stock: enter yes or no.'],
    ]);
    expect(preview.openingValue).toBe(0);
  });

  it('files products under an existing category and refuses one that is not on the list', () => {
    createCategory(context.db, { name: 'Drinks' }, ACTOR);
    const rows = sheet(['Milo', '', '35', '45', 'drinks', '', '', ''], ['Bread', '', '5', '6', 'Bakery', 'No', '', '']);
    const preview = previewProductImport(context.db, rows, guessColumns(rows[0]!), 'pack');
    expect(preview.rows[0]).toMatchObject({ categoryName: 'Drinks', problems: [] });
    expect(preview.rows[1]!.problems).toEqual(['Category Bakery is not on your Categories list.']);

    run(rows);
    const [milo] = context.db.select().from(products).all();
    expect(milo).toMatchObject({ name: 'Milo', trackInventory: true });
    expect(milo!.categoryId).not.toBeNull();
  });

  it('a product that fails takes the opening stock of the whole file with it', () => {
    context.connection.exec(
      "CREATE TRIGGER refuse_bag BEFORE INSERT ON products WHEN NEW.name = 'Bag' BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    expect(() => run(sheet(['Tin', '', '1', '5', '', '', '10', ''], ['Bag', '', '1', '6', '', '', '', '']))).toThrow('disk full');
    expect(context.db.select().from(stockAdjustments).all()).toHaveLength(0);
    expect(context.db.select().from(journalEntries).all()).toHaveLength(0);
    expect(getAccountBalanceByCode(context.db, ACCOUNT_CODES.INVENTORY)).toBe(0);
  });
});
