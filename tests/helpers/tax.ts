import { eq, ne } from 'drizzle-orm';

import { businessSettings, taxComponents } from '@/db/schema';
import type { Db } from '@/db/types';

/**
 * Putting a test shop's taxes into a known state.
 *
 * What a shop charges lives in `tax_components`, not on the settings row, so a
 * test that wants "12.5% added on top" has to say so where the sale will
 * actually read it. Setting `businessSettings.taxRateBp` does nothing at all
 * now — it is derived — and a test that set it would pass or fail for reasons
 * that have nothing to do with what it is checking.
 */

/** One tax at one rate. The levies are switched off so nothing else is charged. */
export function setSingleTax(
  db: Db,
  { rateBp, inclusive = false }: { rateBp: number; inclusive?: boolean },
): void {
  db.update(businessSettings)
    .set({ taxEnabled: true, taxInclusive: inclusive })
    .where(eq(businessSettings.id, 1))
    .run();

  db.update(taxComponents)
    .set({ isActive: false })
    .where(ne(taxComponents.code, 'VAT'))
    .run();

  db.update(taxComponents)
    .set({ rateBp, isActive: true })
    .where(eq(taxComponents.code, 'VAT'))
    .run();
}

/** All three Ghanaian taxes at their statutory rates: NHIL 2.5, GETFund 2.5, VAT 15. */
export function setGhanaTaxes(db: Db, { inclusive = false }: { inclusive?: boolean } = {}): void {
  db.update(businessSettings)
    .set({ taxEnabled: true, taxInclusive: inclusive })
    .where(eq(businessSettings.id, 1))
    .run();

  db.update(taxComponents).set({ isActive: true }).run();
}

/** Charge nothing, without disturbing what is set up. */
export function setNoTax(db: Db): void {
  db.update(businessSettings)
    .set({ taxEnabled: false })
    .where(eq(businessSettings.id, 1))
    .run();
}
