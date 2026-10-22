import { sql } from 'drizzle-orm';

import { writeTransaction } from '@/db/transaction';
import type { Db } from '@/db/types';
import { products, units } from '@/db/schema';
import { divRoundHalf, minor, parseMoney, toDecimalString, type Minor } from '@/domain/money';
import { parsePositiveQty, parseQty, type Qty } from '@/domain/quantity';
import { isDomainError, ValidationError } from '@/domain/errors';
import { createProduct, type ProductInput } from './catalog.service';
import type { Actor } from './journal.service';
import {
  IMPORT_FIELDS,
  type ColumnMap,
  type ImportField,
  type ImportPreview,
  type PreviewRow,
} from '@/lib/product-import-fields';

/**
 * Adding many products at once from a spreadsheet the shop already keeps.
 *
 * Two steps, and the first one writes nothing: `previewProductImport` says, row
 * by row, exactly what would be created and why a row would be skipped.
 * `importProducts` then re-runs that same preview from the same raw cells — it
 * never trusts a preview the browser sends back — and creates every clean row
 * through `createProduct`, in one transaction, so the import lands whole or not
 * at all.
 *
 * Products only. Stock is never imported: opening stock goes in through a
 * stock adjustment, so its value traces to the ledger like every other unit.
 */

/** Headings each field is recognised by, after lower-casing and squeezing spaces. */
const HEADINGS: Record<ImportField, readonly string[]> = {
  name: ['product', 'product name', 'name', 'item', 'item name', 'description'],
  sku: ['sku', 'code', 'product code', 'item code'],
  barcode: ['barcode', 'bar code'],
  unit: ['unit', 'uom'],
  costPrice: ['cost price', 'cost', 'unit cost', 'cost per piece', 'cost per unit'],
  sellingPrice: ['selling price', 'price', 'sale price', 'selling price per piece', 'selling price per unit'],
  altFactor: ['pieces per pack', 'units per pack', 'qty per pack', 'pack size', 'pcs per pack'],
  altCostPrice: ['cost per pack', 'pack cost', 'cost price per pack'],
  altSellingPrice: ['selling price per pack', 'pack price', 'price per pack'],
  minStock: ['reorder level', 'min stock', 'minimum stock', 'reorder'],
};

/** At most this many rows in one import; past it the shop should split the file. */
export const MAX_IMPORT_ROWS = 5_000;

const squeeze = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * A first guess at the column for each field, from the heading row. Each column
 * feeds one field; the first matching column wins, and when two columns share
 * a heading the preview says so rather than trusting the guess quietly.
 */
export function guessColumns(header: readonly string[]): ColumnMap {
  const map: ColumnMap = {};
  const used = new Set<number>();
  for (const { key } of IMPORT_FIELDS) {
    const index = header.findIndex((cell, i) => !used.has(i) && HEADINGS[key].includes(squeeze(cell)));
    if (index >= 0) {
      map[key] = index;
      used.add(index);
    }
  }
  return map;
}



/**
 * A spreadsheet amount in minor units. More than two decimals — a formula's
 * 1.7592592592592591 — is rounded half up to the pesewa and noted; anything
 * else goes through `parseMoney` and is refused if it is not a plain amount.
 */
function readMoney(text: string, label: string, notes: string[]): Minor {
  const long = /^(\d+)\.(\d{3,})$/.exec(text.trim());
  if (!long) {
    const value = parseMoney(text);
    // createProduct refuses a negative price; say so in the preview, not as a failed import.
    if (value < 0) throw new ValidationError(`"${text.trim()}" is negative.`);
    return value;
  }
  const [, whole, fraction] = long as unknown as [string, string, string];
  const rounded = divRoundHalf(BigInt(whole + fraction), 10n ** BigInt(fraction.length - 2));
  const value = minor(Number(rounded));
  notes.push(`${label} ${trimDigits(text)} rounded to ${toDecimalString(value, false)}`);
  return value;
}

/** Units per pack, e.g. "50". Float noise like 49.99999999 is refused, not rounded: a pack size is counted, not priced. */
function readFactor(text: string): Qty {
  const long = /^(\d+)\.(\d{4,})$/.exec(text.trim());
  if (long) throw new ValidationError(`Units per pack "${trimDigits(text)}" is not a whole count.`);
  return parsePositiveQty(text, 'Units per pack');
}

const trimDigits = (text: string) => text.trim().replace(/^(\d+\.\d{4})\d+$/, '$1…');

function message(error: unknown): string {
  if (isDomainError(error)) return error.userMessage;
  throw error;
}

/**
 * What an import of these rows would do, without doing any of it.
 *
 * `rows[0]` is the heading row. Blank rows are left out of the preview — a
 * sheet of 68 products and 120 empty formatted rows is a sheet of 68 products.
 */
export function previewProductImport(
  db: Db,
  rows: readonly (readonly string[])[],
  map: ColumnMap,
  packUnitText: string,
): ImportPreview {
  if (rows.length - 1 > MAX_IMPORT_ROWS) {
    throw new ValidationError(`That sheet has more than ${MAX_IMPORT_ROWS} rows. Split it into smaller files.`);
  }
  if (map.name === undefined) throw new ValidationError('Choose the column that holds the product name.');

  const header = rows[0] ?? [];
  const warnings: string[] = [];
  const seenHeadings = new Map<string, number>();
  header.forEach((cell, i) => {
    const key = squeeze(cell);
    if (!key) return;
    const first = seenHeadings.get(key);
    if (first === undefined) seenHeadings.set(key, i);
    else warnings.push(`Columns ${columnLetter(first)} and ${columnLetter(i)} are both headed "${cell.trim()}". Check the right one is chosen below.`);
  });

  const listed = new Map(
    db.select({ symbol: units.symbol }).from(units).all().map((unit) => [unit.symbol.toLowerCase(), unit.symbol]),
  );
  const defaultUnit = listed.get('pcs') ?? 'pcs';
  const packUnit = packUnitText.trim();
  const newUnits = new Set<string>();
  const useUnit = (text: string) => {
    const known = listed.get(text.toLowerCase());
    if (known) return known;
    newUnits.add(text);
    return text;
  };

  const takenCodes = new Set(
    db
      .select({ code: sql<string>`lower(${products.sku})` })
      .from(products)
      .where(sql`${products.sku} IS NOT NULL`)
      .all()
      .map((row) => row.code),
  );
  const takenBarcodes = new Set(
    db
      .select({ code: sql<string>`lower(${products.barcode})` })
      .from(products)
      .where(sql`${products.barcode} IS NOT NULL`)
      .all()
      .map((row) => row.code),
  );
  const fileCodes = new Map<string, number>();
  const fileBarcodes = new Map<string, number>();

  const result: PreviewRow[] = [];
  let unnamed = 0;
  rows.slice(1).forEach((cells, index) => {
    const line = index + 2;
    const cell = (field: ImportField) => {
      const column = map[field];
      return column === undefined ? '' : (cells[column] ?? '').trim();
    };
    if (IMPORT_FIELDS.every(({ key }) => cell(key) === '')) return;
    // A formula filled down past the list leaves rows of 0.00 with no name and
    // no code. They are not products; they are counted, not listed one by one.
    if (cell('name') === '' && cell('sku') === '') {
      unnamed++;
      return;
    }

    const problems: string[] = [];
    const notes: string[] = [];
    const name = cell('name').replace(/\s+/g, ' ');
    const sku = cell('sku');
    const barcode = cell('barcode');
    if (!name) problems.push('No product name.');

    if (sku) {
      const key = sku.toLowerCase();
      if (takenCodes.has(key)) problems.push(`Code ${sku} is already used by a product.`);
      else if (fileCodes.has(key)) problems.push(`Code ${sku} is also on row ${fileCodes.get(key)}.`);
      else fileCodes.set(key, line);
    }
    if (barcode) {
      const key = barcode.toLowerCase();
      if (takenBarcodes.has(key)) problems.push(`Barcode ${barcode} is already used by a product.`);
      else if (fileBarcodes.has(key)) problems.push(`Barcode ${barcode} is also on row ${fileBarcodes.get(key)}.`);
      else fileBarcodes.set(key, line);
    }

    const unit = useUnit(cell('unit') || defaultUnit);

    const amount = (field: ImportField, label: string): Minor | null => {
      const text = cell(field);
      if (!text) return null;
      try {
        return readMoney(text, label, notes);
      } catch (error) {
        problems.push(`${label}: ${message(error)}`);
        return null;
      }
    };

    let altFactor: Qty | null = null;
    if (cell('altFactor')) {
      try {
        altFactor = readFactor(cell('altFactor'));
      } catch (error) {
        problems.push(message(error));
      }
    }
    const altCostPrice = amount('altCostPrice', 'Cost per pack');
    const altSellingPrice = amount('altSellingPrice', 'Selling price per pack');
    let costPrice = amount('costPrice', 'Cost price');
    let sellingPrice = amount('sellingPrice', 'Selling price');

    let altUnit: string | null = null;
    if (altFactor !== null) {
      if (!packUnit) problems.push('Name the pack unit to import units per pack.');
      else if (packUnit.toLowerCase() === unit.toLowerCase()) problems.push('The pack unit must differ from the unit.');
      else altUnit = useUnit(packUnit);
    } else if (altCostPrice !== null || altSellingPrice !== null) {
      problems.push('Pack prices need the number of units per pack.');
    }

    // A unit price the sheet does not give is the pack price over the pack
    // size — shown as worked out, never passed off as typed in.
    const perUnit = (pack: Minor | null) =>
      pack !== null && altFactor !== null ? minor(Number(divRoundHalf(BigInt(pack) * 1000n, BigInt(altFactor)))) : null;
    if (sellingPrice === null && perUnit(altSellingPrice) !== null) {
      sellingPrice = perUnit(altSellingPrice);
      notes.push(`Selling price worked out from the pack price: ${toDecimalString(sellingPrice!, false)}`);
    }
    if (costPrice === null && perUnit(altCostPrice) !== null) {
      costPrice = perUnit(altCostPrice);
      notes.push(`Cost price worked out from the pack cost: ${toDecimalString(costPrice!, false)}`);
    }
    if (sellingPrice === null && !problems.some((p) => p.startsWith('Selling price'))) {
      problems.push('No selling price.');
    }
    if (costPrice === null && !problems.some((p) => p.startsWith('Cost price'))) {
      notes.push('No cost price — set to 0.00.');
    }

    if (cell('minStock')) {
      try {
        if (parseQty(cell('minStock')) < 0) problems.push('Reorder level cannot be negative.');
      } catch (error) {
        problems.push(`Reorder level: ${message(error)}`);
      }
    }

    result.push({
      line,
      name,
      sku,
      unit,
      costPrice: costPrice ?? minor(0),
      sellingPrice: sellingPrice ?? minor(0),
      altUnit,
      altFactor,
      altCostPrice: altUnit ? altCostPrice : null,
      altSellingPrice: altUnit ? altSellingPrice : null,
      problems,
      notes,
    });
  });

  if (unnamed > 0) {
    warnings.push(`${unnamed} row${unnamed === 1 ? ' has' : 's have'} figures but no name or code, and will be left out.`);
  }
  const ready = result.filter((row) => row.problems.length === 0).length;
  // A unit only counts as new if a row that will actually be imported uses it.
  const usedUnits = new Set(
    result.filter((row) => row.problems.length === 0).flatMap((row) => [row.unit, row.altUnit ?? '']),
  );
  return {
    rows: result,
    newUnits: [...newUnits].filter((unit) => usedUnits.has(unit)),
    warnings,
    ready,
    skipped: result.length - ready,
  };
}

/**
 * Create every row the preview of these same cells marks ready, in one
 * transaction. Returns how many products were created. Rows with problems are
 * skipped — the owner saw them listed, with the reason, before pressing import.
 */
export function importProducts(
  db: Db,
  rows: readonly (readonly string[])[],
  map: ColumnMap,
  packUnit: string,
  actor: Actor,
): number {
  const preview = previewProductImport(db, rows, map, packUnit);
  const ready = preview.rows.filter((row) => row.problems.length === 0);
  if (ready.length === 0) throw new ValidationError('There are no rows ready to import.');

  return writeTransaction(db, (tx) => {
    for (const row of ready) {
      const cells = rows[row.line - 1] ?? [];
      const barcode = map.barcode === undefined ? '' : (cells[map.barcode] ?? '').trim();
      const minStock = map.minStock === undefined ? '' : (cells[map.minStock] ?? '').trim();
      const input: ProductInput = {
        name: row.name,
        sku: row.sku || undefined,
        barcode: barcode || undefined,
        unit: row.unit,
        altUnit: row.altUnit,
        altFactor: row.altFactor,
        altCostPrice: row.altCostPrice,
        altSellingPrice: row.altSellingPrice,
        costPrice: row.costPrice,
        sellingPrice: row.sellingPrice,
        minStock: minStock ? parseQty(minStock) : null,
      };
      try {
        createProduct(tx, input, actor);
      } catch (error) {
        if (isDomainError(error)) {
          throw new ValidationError(`Row ${row.line} (${row.name}): ${error.userMessage} Nothing was imported.`);
        }
        throw error;
      }
    }
    return ready.length;
  });
}

function columnLetter(index: number): string {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}
