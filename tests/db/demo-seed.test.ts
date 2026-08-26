import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { businessSettings, productBatches, products } from '@/db/schema';
import { seedDemo } from '@/db/seed/demo';
import { countRealRecords } from '@/db/seed';
import { verifyBatchCoverage, verifyProductStock } from '@/services/inventory.service';
import { getTrialBalance } from '@/services/reporting/balances.service';

/**
 * `npm run db:seed` has to actually run.
 *
 * It was broken for several commits and nothing noticed. The price-override
 * gate began refusing a discount unless the caller declared the right, the demo
 * seed gives one on a sale, and it had never been told — so seeding died on that
 * line with "Not permitted: discount the whole sale". Every unit test passed
 * throughout, because they build their own fixtures and never call the seed.
 *
 * The smoke test could not catch it either: it runs against a server whose
 * database is already seeded.
 *
 * So this is the gap. It is slow by the standards of this suite — the seed
 * hashes two passwords with scrypt — and worth it, because a seed that does not
 * run is a first-install that does not work.
 */

let context: TestDatabase;

beforeEach(() => {
  context = createTestDatabase();
});

afterEach(() => context.cleanup());

describe('the demo seed', () => {
  it('runs to completion', async () => {
    await expect(seedDemo(context.db, new Date('2026-08-25T09:00:00Z'))).resolves.toBeUndefined();

    const settings = context.db
      .select()
      .from(businessSettings)
      .where(eq(businessSettings.id, 1))
      .get()!;

    // The flag is written last, so it only stands if everything before it did.
    expect(settings.hasDemoData).toBe(true);
  });

  it('leaves a shop whose books balance', async () => {
    await seedDemo(context.db, new Date('2026-08-25T09:00:00Z'));
    expect(getTrialBalance(context.db).balanced).toBe(true);
  });

  it('leaves every product agreeing with its own movement history', async () => {
    await seedDemo(context.db, new Date('2026-08-25T09:00:00Z'));

    for (const row of context.db.select({ id: products.id }).from(products).all()) {
      expect(verifyProductStock(context.db, row.id).ok, `product ${row.id}`).toBe(true);
    }
  });

  it('leaves every unit of stock owned by a batch', async () => {
    /**
     * A demo database is built AFTER the migration that backfills opening
     * batches, by services that do not allocate batches yet. Without the seed
     * opening them itself, a freshly installed shop would fail its own preflight
     * on a database nobody had touched.
     */
    await seedDemo(context.db, new Date('2026-08-25T09:00:00Z'));

    const coverage = verifyBatchCoverage(context.db);
    expect(coverage.length).toBeGreaterThan(0);
    expect(coverage.filter((row) => !row.ok)).toEqual([]);

    // Undated, like the migration's: no date here was entered by anybody.
    const batches = context.db.select().from(productBatches).all();
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.every((batch) => batch.expiryDate === null)).toBe(true);
    expect(batches.every((batch) => batch.isDemo)).toBe(true);
  });
});

describe('what the seed refuses to overwrite', () => {
  /**
   * A shop name somebody typed is a decision, and the seed does not get to
   * overrule it.
   *
   * This cost a real shop its name twice in one afternoon: the database was
   * reset and re-seeded to clear test data, and `db:seed` renamed the shop to
   * its own demo identity both times. Nothing warned, because renaming was
   * exactly what the code said to do.
   */
  it('leaves a shop name that somebody chose', async () => {
    context.db
      .update(businessSettings)
      .set({ businessName: 'Nuna Trading & Co.', tagline: 'Where Quality meets Affordability' })
      .where(eq(businessSettings.id, 1))
      .run();

    await seedDemo(context.db, new Date('2026-08-25T09:00:00Z'));

    const settings = context.db
      .select()
      .from(businessSettings)
      .where(eq(businessSettings.id, 1))
      .get()!;

    expect(settings.businessName).toBe('Nuna Trading & Co.');
    expect(settings.tagline).toBe('Where Quality meets Affordability');
    // The demo data itself still arrived.
    expect(settings.hasDemoData).toBe(true);
  });

  it('still names an unnamed shop, so a fresh demo looks like a shop', async () => {
    await seedDemo(context.db, new Date('2026-08-25T09:00:00Z'));

    const settings = context.db
      .select()
      .from(businessSettings)
      .where(eq(businessSettings.id, 1))
      .get()!;

    expect(settings.businessName).toBe('Adom Provisions');
    expect(settings.address).toContain('Madina Market');
  });

  it('writes over its own previous demo name, which nobody chose', async () => {
    context.db
      .update(businessSettings)
      .set({ businessName: 'Adom Provisions' })
      .where(eq(businessSettings.id, 1))
      .run();

    await seedDemo(context.db, new Date('2026-08-25T09:00:00Z'));

    expect(
      context.db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get()!
        .businessName,
    ).toBe('Adom Provisions');
  });
});

describe('counting what is real', () => {
  /**
   * `NODE_ENV=production` already stops demo data reaching a live shop, but
   * plenty of databases that matter are not in production mode — one being set
   * up, or a copy somebody is checking a figure against. This is the count the
   * seed runner refuses on.
   */
  it('is zero for a database holding only demo data', async () => {
    await seedDemo(context.db, new Date('2026-08-25T09:00:00Z'));
    expect(countRealRecords(context.connection)).toBe(0);
  });

  it('counts a real sale, even beside demo data', async () => {
    await seedDemo(context.db, new Date('2026-08-25T09:00:00Z'));

    // One sale the demo seed did not write — a shop that has started trading.
    context.connection
      .prepare(
        `INSERT INTO sales (receipt_no, kind, business_date, occurred_at, subtotal_minor,
                            discount_minor, tax_minor, total_minor, cogs_minor, status,
                            is_demo, created_at, updated_at)
         VALUES ('RCP-REAL', 'SALE', '2026-08-26', 0, 100, 0, 0, 100, 0, 'POSTED', 0, 0, 0)`,
      )
      .run();

    expect(countRealRecords(context.connection)).toBe(1);
  });
});
