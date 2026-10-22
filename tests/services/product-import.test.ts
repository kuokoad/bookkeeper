import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { products, stockLedger, units } from '@/db/schema';
import { minor } from '@/domain/money';
import { ValidationError } from '@/domain/errors';
import { createProduct } from '@/services/catalog.service';
import { guessColumns, importProducts, previewProductImport } from '@/services/product-import.service';

/**
 * Importing a supplier price list, shaped like the shop's own JCG sheet: two
 * columns headed "cost price", per-piece costs that are formula output, prices
 * given per pack only, and a hundred empty formatted rows at the bottom.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };

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
    expect(importProducts(context.db, SHEET, map(), 'pack', ACTOR)).toBe(2);

    const created = context.db.select().from(products).all();
    expect(created.map((p) => [p.name, p.sku, p.unit, p.altUnit, p.altFactorMilli, p.costPriceMinor, p.sellingPriceMinor])).toEqual([
      ['KRAFTED BOWL 750ML', 'JCG-KB-RD750', 'pcs', 'pack', 50_000, 200, 240],
      ['KRAFTED BOWL RECTANGULAR 1000ML', 'JCG-KB-R1000', 'pcs', 'pack', 50_000, 176, 260],
    ]);
    expect(created.every((p) => p.qtyOnHandMilli === 0 && p.stockValueMinor === 0)).toBe(true);
    expect(context.db.select().from(stockLedger).all()).toHaveLength(0);
  });

  it('re-checks on import, so a code taken since the preview cannot slip in twice', () => {
    importProducts(context.db, SHEET, map(), 'pack', ACTOR);
    // Same file again: every code is now taken, so nothing is ready.
    expect(() => importProducts(context.db, SHEET, map(), 'pack', ACTOR)).toThrow(ValidationError);
    expect(context.db.select().from(products).all()).toHaveLength(2);
  });

  it('lands whole or not at all', () => {
    // The second insert fails inside the transaction; the first must not stay behind.
    context.connection.exec(
      "CREATE TRIGGER refuse_bag BEFORE INSERT ON products WHEN NEW.name = 'Bag' BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const sheet = [['name', 'selling price'], ['Tin', '5'], ['Bag', '6']];
    expect(() => importProducts(context.db, sheet, guessColumns(sheet[0]!), 'pack', ACTOR)).toThrow('disk full');
    expect(context.db.select().from(products).all()).toHaveLength(0);
  });
});
