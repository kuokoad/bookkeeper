import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { businessSettings, products } from '@/db/schema';
import { seedDemo } from '@/db/seed/demo';
import { verifyProductStock } from '@/services/inventory.service';
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
});
