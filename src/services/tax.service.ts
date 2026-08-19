import { and, asc, eq } from 'drizzle-orm';

import type { Db, Tx } from '@/db/types';
import { businessSettings, taxComponents } from '@/db/schema';
import { minor, type Minor } from '@/domain/money';
import {
  taxOnNet,
  taxWithinGross,
  totalRateBp,
  type TaxBreakdown,
  type TaxComponent,
} from '@/domain/tax/components';

/**
 * What this shop charges, and how it applies to a sale.
 *
 * The components live in the database so a budget change is a settings edit
 * rather than a new version of the software. Everything else about them —
 * how they combine, how the parts are rounded — is in the domain, which knows
 * nothing about tables.
 */

export interface ShopTaxProfile {
  /** Active components, in the order they should appear on a receipt. */
  components: TaxComponent[];
  /** The database id for each, so postings can find the right account. */
  accountIdByCode: Map<string, number>;
  componentIdByCode: Map<string, number>;
  /** Combined rate in basis points. */
  totalRateBp: number;
  /** Whether the shop charges tax at all. */
  enabled: boolean;
  /** Whether shelf prices already include it. */
  inclusive: boolean;
}

/**
 * Read the shop's tax setup.
 *
 * Returns an EMPTY component list when tax is switched off, so callers do not
 * each have to remember to check: charging nothing is expressed as having
 * nothing to charge, not as a flag they might forget.
 */
export function getTaxProfile(db: Db | Tx): ShopTaxProfile {
  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  const enabled = settings?.taxEnabled ?? false;
  const inclusive = settings?.taxInclusive ?? false;

  const rows = enabled
    ? db
        .select()
        .from(taxComponents)
        .where(and(eq(taxComponents.isActive, true)))
        .orderBy(asc(taxComponents.sortOrder), asc(taxComponents.id))
        .all()
        .filter((row) => row.rateBp > 0)
    : [];

  return {
    components: rows.map((row) => ({
      code: row.code,
      name: row.name,
      rateBp: row.rateBp,
      isRecoverable: row.isRecoverable,
    })),
    accountIdByCode: new Map(rows.map((row) => [row.code, row.glAccountId])),
    componentIdByCode: new Map(rows.map((row) => [row.code, row.id])),
    totalRateBp: totalRateBp(rows.map((row) => ({ ...row, isRecoverable: row.isRecoverable }))),
    enabled,
    inclusive,
  };
}

/**
 * Work out the tax on an amount, whichever way the shop prices its shelves.
 *
 * `amount` is the net goods value when prices exclude tax, and the price on the
 * label when they include it. The distinction is the shop's setting, not the
 * caller's business, which is why it is resolved here.
 */
export function applyTax(profile: ShopTaxProfile, amount: Minor): TaxBreakdown {
  return profile.inclusive
    ? taxWithinGross(amount, profile.components)
    : taxOnNet(amount, profile.components);
}

/** Total of the recoverable components only — what a purchase can reclaim. */
export function recoverableTotal(lines: readonly { isRecoverable: boolean; amount: Minor }[]): Minor {
  return minor(
    lines.reduce((running, line) => running + (line.isRecoverable ? line.amount : 0), 0),
  );
}

/** Total of the components that are NOT reclaimable — part of what goods cost. */
export function nonRecoverableTotal(
  lines: readonly { isRecoverable: boolean; amount: Minor }[],
): Minor {
  return minor(
    lines.reduce((running, line) => running + (line.isRecoverable ? 0 : line.amount), 0),
  );
}
