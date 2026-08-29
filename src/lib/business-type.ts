import { BUSINESS_TYPES, type BusinessType } from '@/db/schema/system';

export { BUSINESS_TYPES, type BusinessType };

/**
 * What kind of shop this is, and what it is therefore offered.
 *
 * Three ideas that look alike and must not be confused:
 *
 *  - a PERMISSION answers "may this person see it", is enforced by the page's
 *    own guard, and is the only one of the three that protects anything;
 *  - a BUSINESS TYPE answers "does this shop want to be offered it", is
 *    enforced by the menu and nothing else, and never guards a route — the
 *    address of a feature that has been put away still opens normally;
 *  - DATA answers "does the shop already have some", and always wins. A
 *    warning about stock that exists is never hidden by a menu setting.
 *
 * Nothing here changes a figure. A shop that switches type must see the same
 * profit it saw yesterday, and `tests/app/business-type-moves-nothing.test.ts`
 * is what holds that true.
 *
 * This half is pure so it can be tested without a database, exactly as
 * `look.ts` is.
 */

/** Every feature that can be switched off. Each key MUST have a column. */
export const FEATURE_KEYS = ['expiry_batches', 'quotations'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** The resolved answer to "what is this shop offered". */
export type FeatureSwitches = Record<FeatureKey, boolean>;

export interface FeatureDefinition {
  key: FeatureKey;
  /** The words on the switch in Settings. */
  name: string;
  blurb: string;
  /** What goes away when it is off, in the owner's words. */
  hides: string;
  /** The column in `business_settings` that stores it. */
  column: string;
  /**
   * Where each business type starts.
   *
   * A total record on purpose: adding a fourth business type is then a compile
   * error here, rather than a feature that is silently undefined for it.
   */
  defaultOn: Readonly<Record<BusinessType, boolean>>;
}

export const FEATURES: Readonly<Record<FeatureKey, FeatureDefinition>> = {
  expiry_batches: {
    key: 'expiry_batches',
    name: 'Expiry dates and batches',
    blurb:
      'Put a date on a delivery, be warned before it goes off, and stop the till selling stock that has passed it.',
    hides: 'the expiry date box on a delivery, the reminder setting on a product, and the "expiring soon" filter',
    column: 'feature_expiry_batches',
    defaultOn: { general_retail: true, building_materials: false, other: true },
  },
  quotations: {
    key: 'quotations',
    name: 'Quotations',
    blurb:
      'Write a customer a priced quote they can take away, then turn it into a sale without typing it again.',
    hides: 'the Quotations menu entry and everything reached from it',
    column: 'feature_quotations',
    // The mirror of expiry dates. A materials yard quotes constantly because a
    // contractor is comparing three of them; a mini-mart sells over a counter
    // and almost never does.
    defaultOn: { general_retail: false, building_materials: true, other: true },
  },
};

/** The names a shop owner sees, and what each one is for. */
export const BUSINESS_TYPE_LABELS: Record<BusinessType, { name: string; blurb: string }> = {
  general_retail: {
    name: 'General retail',
    blurb: 'A provisions shop, a mini-mart, a chemical shop. Everything switched on.',
  },
  building_materials: {
    name: 'Building materials',
    blurb: 'Cement, pipes, roofing, hardware. Nothing carries a date, so dates and batches are put away.',
  },
  other: {
    name: 'Something else',
    blurb: 'Shows every feature. Choose this if neither of the others quite fits.',
  },
};

export function isBusinessType(value: unknown): value is BusinessType {
  return typeof value === 'string' && (BUSINESS_TYPES as readonly string[]).includes(value);
}

export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === 'string' && (FEATURE_KEYS as readonly string[]).includes(value);
}

/**
 * Where a type starts.
 *
 * Used when the type is chosen at first run, when it is changed in Settings,
 * and as the fallback when the settings row cannot be read.
 */
export function defaultFeatures(type: BusinessType): FeatureSwitches {
  return Object.fromEntries(
    FEATURE_KEYS.map((key) => [key, FEATURES[key].defaultOn[type]]),
  ) as FeatureSwitches;
}

/**
 * The type's defaults, with any switch the owner has since moved.
 *
 * The stored switches are already resolved — choosing a type stamps its
 * defaults over them once, at the moment of the change — so on a real settings
 * row this is the identity. It exists so a caller holding only a partial (a
 * form submission, a seed, a test) resolves it the one same way.
 */
export function resolveFeatures(
  type: BusinessType,
  overrides: Partial<FeatureSwitches> = {},
): FeatureSwitches {
  const resolved = defaultFeatures(type);
  for (const key of FEATURE_KEYS) {
    const value = overrides[key];
    if (typeof value === 'boolean') resolved[key] = value;
  }
  return resolved;
}

/**
 * Read the switches off a settings row.
 *
 * Structural rather than typed against the schema, so this module stays free of
 * the database and testable without one.
 */
export function featuresFromRow(row: {
  businessType: string;
  featureExpiryBatches: boolean;
  featureQuotations: boolean;
}): FeatureSwitches {
  const type = isBusinessType(row.businessType) ? row.businessType : 'general_retail';
  return resolveFeatures(type, {
    expiry_batches: row.featureExpiryBatches,
    quotations: row.featureQuotations,
  });
}

/**
 * Drop the entries this shop is not offered.
 *
 * The one predicate behind every hidden link. The sidebar, the mobile bar, the
 * Reports index and the Accounting index all call this, so they cannot reach
 * different conclusions about the same feature.
 */
export function visible<T extends { feature?: FeatureKey }>(
  items: readonly T[],
  features: FeatureSwitches,
): T[] {
  return items.filter((item) => item.feature === undefined || features[item.feature]);
}
