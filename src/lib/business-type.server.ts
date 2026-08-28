import 'server-only';

import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { defaultFeatures, featuresFromRow, type FeatureSwitches } from './business-type';

/**
 * Which features this shop is offered.
 *
 * For a caller that does not already hold the settings row. A caller that DOES
 * — the app layout reads it for the shop name, and several pages call
 * `getSettings` — should use the pure `featuresFromRow` on what it already has:
 * two reads of the same singleton in one render is how the name in the menu and
 * the menu itself come to disagree.
 *
 * Everything falls back to General Retail, which is every feature switched on.
 * A missing row, a database that will not open, or a type written by hand into
 * the file must leave the shop seeing MORE than it needs, never less — the
 * worst outcome of a failed read here is a menu entry nobody wanted, and losing
 * sight of a feature the shop uses every day is not an acceptable alternative.
 */
export function getFeatures(): FeatureSwitches {
  try {
    const row = db
      .select({
        businessType: businessSettings.businessType,
        featureExpiryBatches: businessSettings.featureExpiryBatches,
      })
      .from(businessSettings)
      .where(eq(businessSettings.id, 1))
      .get();

    return row ? featuresFromRow(row) : defaultFeatures('general_retail');
  } catch {
    return defaultFeatures('general_retail');
  }
}
