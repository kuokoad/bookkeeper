import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { businessSettings, taxComponents } from '@/db/schema';
import { seedTaxComponents } from '@/db/seed/core';
import { getTaxProfile, applyTax } from '@/services/tax.service';
import { minor } from '@/domain/money';

/**
 * How a shop's taxes are set up, and what an upgrade must not do to them.
 *
 * The rates arrive as data rather than code, because Ghana changes them with
 * the national budget. That makes the SEED a thing with consequences: run
 * carelessly, it could start charging a shop's customers a different amount
 * than they were charged yesterday, with nothing on screen to explain it.
 */

let context: TestDatabase;

const rates = () =>
  Object.fromEntries(
    context.db
      .select()
      .from(taxComponents)
      .all()
      .map((row) => [row.code, { rateBp: row.rateBp, active: row.isActive }]),
  );

beforeEach(() => {
  context = createTestDatabase();
});

afterEach(() => context.cleanup());

describe('a shop setting up for the first time', () => {
  it('gets the three Ghanaian taxes at their statutory rates', () => {
    expect(rates()).toEqual({
      NHIL: { rateBp: 250, active: true },
      GETFUND: { rateBp: 250, active: true },
      VAT: { rateBp: 1_500, active: true },
    });
  });

  it('charges nothing until the shop says it is registered', () => {
    // Seeded ready, but switched off: most small shops are not VAT-registered,
    // and adding 20% to every sale on installation day would overcharge every
    // customer.
    const profile = getTaxProfile(context.db);
    expect(profile.enabled).toBe(false);
    expect(profile.components).toEqual([]);
    expect(applyTax(profile, minor(10_000)).total).toBe(0);
  });

  it('charges all three once switched on', () => {
    context.db
      .update(businessSettings)
      .set({ taxEnabled: true })
      .where(eq(businessSettings.id, 1))
      .run();

    const profile = getTaxProfile(context.db);
    expect(profile.totalRateBp).toBe(2_000);

    const result = applyTax(profile, minor(10_000));
    expect(result.lines.map((line) => [line.code, line.amount])).toEqual([
      ['NHIL', 250],
      ['GETFUND', 250],
      ['VAT', 1_500],
    ]);
    expect(result.total).toBe(2_000);
  });

  it('puts each one in its own account, so they can be remitted separately', () => {
    const byCode = new Map(
      context.db
        .select()
        .from(taxComponents)
        .all()
        .map((row) => [row.code, row.glAccountId]),
    );

    // Three distinct accounts — netting them into one would hide that only VAT
    // can be set against what was paid on purchases.
    expect(new Set(byCode.values()).size).toBe(3);
  });

  it('marks only VAT as reclaimable on purchases', () => {
    context.db
      .update(businessSettings)
      .set({ taxEnabled: true })
      .where(eq(businessSettings.id, 1))
      .run();

    const recoverable = getTaxProfile(context.db)
      .components.filter((component) => component.isRecoverable)
      .map((component) => component.code);

    expect(recoverable).toEqual(['VAT']);
  });
});

describe('a shop that was already charging tax', () => {
  /**
   * The case that could quietly overcharge real customers. Before this, tax was
   * a single rate on the settings row; seeding Ghana's defaults over a shop
   * already set to 12.5% would take it to 20% the moment it upgraded.
   */
  function existingShopAt(rateBp: number, taxEnabled = true) {
    const fresh = createTestDatabase();
    // Wind back to the state before this feature existed: a rate configured,
    // and no components.
    fresh.connection.prepare('DELETE FROM tax_components').run();
    fresh.db
      .update(businessSettings)
      .set({ taxEnabled, taxRateBp: rateBp })
      .where(eq(businessSettings.id, 1))
      .run();
    return fresh;
  }

  it('carries its own rate forward rather than adopting the defaults', () => {
    const shop = existingShopAt(1_250);
    try {
      shop.db.transaction((tx) => seedTaxComponents(tx as never, new Date()));

      const profile = getTaxProfile(shop.db);
      // Still 12.5%, exactly as before. Not 20%.
      expect(profile.totalRateBp).toBe(1_250);
      expect(applyTax(profile, minor(10_000)).total).toBe(1_250);
    } finally {
      shop.cleanup();
    }
  });

  it('adds the levies switched OFF, for the owner to turn on deliberately', () => {
    const shop = existingShopAt(1_250);
    try {
      shop.db.transaction((tx) => seedTaxComponents(tx as never, new Date()));

      const rows = Object.fromEntries(
        shop.db
          .select()
          .from(taxComponents)
          .all()
          .map((row) => [row.code, row.isActive]),
      );
      expect(rows).toEqual({ NHIL: false, GETFUND: false, VAT: true });
    } finally {
      shop.cleanup();
    }
  });

  it('says so in the audit log rather than changing things quietly', () => {
    const shop = existingShopAt(1_250);
    try {
      shop.db.transaction((tx) => seedTaxComponents(tx as never, new Date()));

      const entries = shop.connection
        .prepare("SELECT summary FROM audit_logs WHERE entity_id = 'tax-components'")
        .all() as { summary: string }[];

      expect(entries).toHaveLength(1);
      expect(entries[0]!.summary).toMatch(/switched off/i);
    } finally {
      shop.cleanup();
    }
  });

  it('carries the rate forward even when tax is switched off', () => {
    /**
     * The delayed version of the same overcharge. A shop that set 12.5% and
     * then switched tax off still has 12.5% on its Settings screen, and still
     * means it. Taking VAT to 15% behind that unchanged number would overcharge
     * every customer the day the owner switches tax back on.
     */
    const shop = existingShopAt(1_250, false);
    try {
      shop.db.transaction((tx) => seedTaxComponents(tx as never, new Date()));

      const rows = Object.fromEntries(
        shop.db
          .select()
          .from(taxComponents)
          .all()
          .map((row) => [row.code, { rateBp: row.rateBp, active: row.isActive }]),
      );
      expect(rows['VAT']).toEqual({ rateBp: 1_250, active: true });
      expect(rows['NHIL']!.active).toBe(false);
      expect(rows['GETFUND']!.active).toBe(false);

      // Switching tax on charges what the owner had configured, not 20%.
      shop.db
        .update(businessSettings)
        .set({ taxEnabled: true })
        .where(eq(businessSettings.id, 1))
        .run();
      expect(getTaxProfile(shop.db).totalRateBp).toBe(1_250);
    } finally {
      shop.cleanup();
    }
  });

  it('leaves a shop that charged nothing to take the defaults', () => {
    // A shop from before this feature that never set a rate: no components,
    // and a rate of zero. `existingShopAt` winds both back, which matters now
    // that the seed derives `taxRateBp` from the components it creates — a
    // database that still held the derived figure would not be a pre-feature
    // database at all.
    const shop = existingShopAt(0, false);
    try {
      shop.db.transaction((tx) => seedTaxComponents(tx as never, new Date()));

      const active = shop.db
        .select()
        .from(taxComponents)
        .all()
        .filter((row) => row.isActive)
        .map((row) => row.code)
        .sort();
      expect(active).toEqual(['GETFUND', 'NHIL', 'VAT']);
    } finally {
      shop.cleanup();
    }
  });
});

describe('running the seed again', () => {
  it('changes nothing, so an upgrade cannot reset a shop that adjusted its rates', () => {
    context.db
      .update(taxComponents)
      .set({ rateBp: 1_750 })
      .where(eq(taxComponents.code, 'VAT'))
      .run();

    context.db.transaction((tx) => seedTaxComponents(tx as never, new Date()));

    expect(rates()['VAT']).toEqual({ rateBp: 1_750, active: true });
  });
});
