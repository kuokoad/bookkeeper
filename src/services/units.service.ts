import { asc, eq, sql } from 'drizzle-orm';
import { writeTransaction } from '@/db/transaction';

import type { Db, Tx } from '@/db/types';
import { products, units, type Product, type Unit } from '@/db/schema';
import { minor, type Minor } from '@/domain/money';
import {
  assertUnitDecimals,
  extendPrice,
  qty as qtyOf,
  QTY_DECIMALS,
  toBaseQty,
  type Qty,
} from '@/domain/quantity';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/errors';
import { writeAudit } from './audit.service';
import type { Actor } from './journal.service';

/**
 * Units of measure, and the one place a line's quantity becomes stock.
 *
 * A product has a base unit and at most one alternate unit ("1 Carton = 24
 * Pcs"). Everything downstream of a document line — the stock ledger, costing,
 * batches, returns — works in the base unit only. `resolveLineUnit` is where an
 * entered quantity is checked against its unit's decimals and converted, so
 * every document converts identically.
 */

export interface UnitInput {
  symbol: string;
  name: string;
  decimalPlaces: number;
}

export interface UnitRow extends Unit {
  productCount: number;
}

function assertUnitInput(input: UnitInput): void {
  if (input.symbol.trim().length === 0) throw new ValidationError('Enter a unit symbol.');
  if (input.symbol.trim().length > 20) throw new ValidationError('Keep the symbol to 20 characters.');
  if (input.name.trim().length === 0) throw new ValidationError('Enter a unit name.');
  if (
    !Number.isInteger(input.decimalPlaces) ||
    input.decimalPlaces < 0 ||
    input.decimalPlaces > QTY_DECIMALS
  ) {
    throw new ValidationError(`Decimal places must be a whole number from 0 to ${QTY_DECIMALS}.`);
  }
}

const findBySymbol = (tx: Tx, symbol: string) =>
  tx
    .select()
    .from(units)
    .where(sql`lower(${units.symbol}) = lower(${symbol.trim()})`)
    .get();

export function listUnits(db: Db): UnitRow[] {
  const used = sql<number>`(SELECT count(*) FROM products p WHERE p.unit = units.symbol OR p.alt_unit = units.symbol)`;
  return db
    .select({
      symbol: units.symbol,
      name: units.name,
      decimalPlaces: units.decimalPlaces,
      createdAt: units.createdAt,
      updatedAt: units.updatedAt,
      productCount: used,
    })
    .from(units)
    .orderBy(asc(sql`lower(${units.symbol})`))
    .all();
}

export function getUnit(db: Db, symbol: string): Unit {
  const unit = findBySymbol(db, symbol);
  if (!unit) throw new NotFoundError('Unit', symbol);
  return unit;
}

export function createUnit(db: Db, input: UnitInput, actor: Actor): string {
  assertUnitInput(input);
  const symbol = input.symbol.trim();

  return writeTransaction(db, (tx) => {
    if (findBySymbol(tx, symbol)) throw new ConflictError(`There is already a unit called "${symbol}".`);
    const now = new Date();
    tx.insert(units)
      .values({ symbol, name: input.name.trim(), decimalPlaces: input.decimalPlaces, createdAt: now, updatedAt: now })
      .run();
    writeAudit(tx, {
      action: 'CREATE',
      entityType: 'unit',
      entityId: symbol,
      userId: actor.id,
      username: actor.username,
      summary: `Created unit "${symbol}"`,
      metadata: { symbol, decimalPlaces: input.decimalPlaces },
      at: now,
    });
    return symbol;
  });
}

/**
 * A rename cascades to every product using the unit (the foreign key does it).
 * Lines already written keep the spelling they were printed with.
 */
export function updateUnit(db: Db, symbol: string, input: UnitInput, actor: Actor): string {
  assertUnitInput(input);
  const next = input.symbol.trim();

  return writeTransaction(db, (tx) => {
    const existing = findBySymbol(tx, symbol);
    if (!existing) throw new NotFoundError('Unit', symbol);
    const clash = findBySymbol(tx, next);
    if (clash && clash.symbol !== existing.symbol) {
      throw new ConflictError(`There is already a unit called "${next}".`);
    }

    const now = new Date();
    tx.update(units)
      .set({ symbol: next, name: input.name.trim(), decimalPlaces: input.decimalPlaces, updatedAt: now })
      .where(eq(units.symbol, existing.symbol))
      .run();
    writeAudit(tx, {
      action: 'UPDATE',
      entityType: 'unit',
      entityId: next,
      userId: actor.id,
      username: actor.username,
      summary: `Updated unit "${existing.symbol}"`,
      metadata: {
        before: { symbol: existing.symbol, decimalPlaces: existing.decimalPlaces },
        after: { symbol: next, decimalPlaces: input.decimalPlaces },
      },
      at: now,
    });
    return next;
  });
}

export function deleteUnit(db: Db, symbol: string, actor: Actor): void {
  writeTransaction(db, (tx) => {
    const existing = findBySymbol(tx, symbol);
    if (!existing) throw new NotFoundError('Unit', symbol);
    const inUse = tx
      .select({ id: products.id })
      .from(products)
      .where(sql`${products.unit} = ${existing.symbol} OR ${products.altUnit} = ${existing.symbol}`)
      .get();
    if (inUse) {
      throw new ConflictError(`"${existing.symbol}" is used by products, so it cannot be deleted.`);
    }
    tx.delete(units).where(eq(units.symbol, existing.symbol)).run();
    writeAudit(tx, {
      action: 'ARCHIVE',
      entityType: 'unit',
      entityId: existing.symbol,
      userId: actor.id,
      username: actor.username,
      summary: `Deleted unit "${existing.symbol}"`,
      at: new Date(),
    });
  });
}

/**
 * The stored spelling of a unit, creating it if it does not exist yet.
 *
 * The product form only offers units from the list; this is for imports,
 * scripts and seeds that name a unit in text. A unit made this way allows three
 * decimals — the behaviour every product had before units existed — and the
 * owner can tighten it on the Units screen.
 */
export function ensureUnit(tx: Tx, symbol: string): string {
  const text = symbol.trim();
  if (text.length === 0) throw new ValidationError('Choose a unit.');
  const existing = findBySymbol(tx, text);
  if (existing) return existing.symbol;
  const now = new Date();
  tx.insert(units)
    .values({ symbol: text, name: text, decimalPlaces: QTY_DECIMALS, createdAt: now, updatedAt: now })
    .run();
  return text;
}

// --- document lines --------------------------------------------------------

export interface EntryColumns {
  entryUnit: string | null;
  entryQtyMilli: number | null;
  entryFactorMilli: number | null;
}

export interface ResolvedLineUnit extends EntryColumns {
  /** The quantity in the product's base unit — what stock moves by. */
  baseQty: Qty;
  /** The shop's reference prices for the unit the line was entered in. */
  listSellingPrice: Minor;
  listCostPrice: Minor;
}

const BASE_ENTRY: EntryColumns = { entryUnit: null, entryQtyMilli: null, entryFactorMilli: null };

function decimalsOf(tx: Tx, symbol: string): number {
  return findBySymbol(tx, symbol)?.decimalPlaces ?? QTY_DECIMALS;
}

/**
 * Check a line's quantity against its unit and convert it to the base unit.
 *
 * `alt` says the quantity was entered in the product's alternate unit. The
 * factor is always read from the product here, never taken from the caller.
 * Signed quantities pass through unchanged in sign, for the mirror lines voids
 * write.
 */
export function resolveLineUnit(tx: Tx, product: Product, qty: Qty, alt?: boolean): ResolvedLineUnit {
  if (alt !== true) {
    assertUnitDecimals(qty, decimalsOf(tx, product.unit), product.unit);
    return {
      ...BASE_ENTRY,
      baseQty: qty,
      listSellingPrice: minor(product.sellingPriceMinor),
      listCostPrice: minor(product.costPriceMinor),
    };
  }

  if (product.altUnit === null || product.altFactorMilli === null) {
    throw new ValidationError(`"${product.name}" has no alternate unit.`);
  }
  assertUnitDecimals(qty, decimalsOf(tx, product.altUnit), product.altUnit);
  const baseQty = toBaseQty(qty, product.altFactorMilli);
  assertUnitDecimals(baseQty, decimalsOf(tx, product.unit), product.unit);

  return {
    entryUnit: product.altUnit,
    entryQtyMilli: qty,
    entryFactorMilli: product.altFactorMilli,
    baseQty,
    // No alternate price set: the base price times the conversion, so a
    // Carton of 24 is never offered at the price of one piece.
    listSellingPrice: minor(
      product.altSellingPriceMinor ?? extendPrice(minor(product.sellingPriceMinor), qtyOf(product.altFactorMilli)),
    ),
    listCostPrice: minor(
      product.altCostPriceMinor ?? extendPrice(minor(product.costPriceMinor), qtyOf(product.altFactorMilli)),
    ),
  };
}
