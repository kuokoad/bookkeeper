import { units } from '@/db/schema';
import type { Db } from '@/db/types';
import { QTY_DECIMALS } from '@/domain/quantity';
import { listProducts } from '@/services/catalog.service';
import type { EntryProduct } from './purchase-entry';

/**
 * The products the new-purchase form offers, with what it needs to check them.
 *
 * Its own module so `tests/app/purchase-form-parity.test.ts` reads products
 * exactly as the page does, decimal places included, rather than a hand-built
 * copy that could agree with the server while the page did not.
 */
export function loadEntryProducts(db: Db): EntryProduct[] {
  // Each product's unit is a foreign key to units.symbol, so the exact symbol
  // finds it. The screen refuses 1.5 Pcs before Save rather than after.
  const decimals = new Map(
    db
      .select({ symbol: units.symbol, decimalPlaces: units.decimalPlaces })
      .from(units)
      .all()
      .map((unit) => [unit.symbol, unit.decimalPlaces]),
  );
  const decimalsOf = (symbol: string) => decimals.get(symbol) ?? QTY_DECIMALS;

  return listProducts(db, { limit: 500 }).map((product) => ({
    id: product.id,
    name: product.name,
    unit: product.unit,
    altUnit: product.altUnit,
    altFactorMilli: product.altFactor as number | null,
    costPrice: product.costPrice as number,
    altCostPrice: product.altCostPrice as number | null,
    qtyOnHandMilli: product.qtyOnHand as number,
    unitDecimals: decimalsOf(product.unit),
    altUnitDecimals: product.altUnit === null ? null : decimalsOf(product.altUnit),
    trackInventory: product.trackInventory,
  }));
}
