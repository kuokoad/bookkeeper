import { eq } from 'drizzle-orm';
import { writeTransaction } from '@/db/transaction';

import type { Db } from '@/db/types';
import { businessSettings, users } from '@/db/schema';
import { createUser } from '@/services/auth.service';
import { defaultStaffPermissions } from '@/lib/auth/permissions';
import { writeAudit } from '@/services/audit.service';
import { toBusinessDate } from '@/lib/format';
import { defaultFeatures } from '@/lib/business-type';
import { seedDemoCatalog } from './demo-catalog';
import { seedDemoPurchases } from './demo-purchases';
import { seedDemoSales } from './demo-sales';
import { seedDemoCashbook } from './demo-cashbook';
import { seedDemoQuotations } from './demo-quotations';
import { openOpeningBatches } from './opening-batches';

/**
 * Development-only demo data.
 *
 * Guarded twice: `env.ts` refuses to start production with SEED_DEMO_DATA=true,
 * and every row written here is marked so it can be purged. The credentials
 * below are published in the README precisely because they must never exist on
 * a real shop's machine.
 */

/** What `seedCore` creates the settings row with — i.e. nobody has named the shop. */
const DEFAULT_BUSINESS_NAME = 'My Shop';

/** The demo shop's own name, safe to write over because a previous seed set it. */
const DEMO_BUSINESS_NAME = 'Structural Supplies';

/** What that type switches on, resolved rather than restated. */
const DEMO_FEATURES = defaultFeatures('building_materials');

export const DEMO_OWNER = {
  username: 'owner',
  displayName: 'Demo Owner',
  password: 'demo-owner-2026',
} as const;

export const DEMO_STAFF = {
  username: 'ama',
  displayName: 'Ama (Demo Staff)',
  password: 'demo-staff-2026',
  pin: '8351',
} as const;

export async function seedDemo(db: Db, now: Date = new Date()): Promise<void> {
  const existingOwner = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, DEMO_OWNER.username))
    .get();

  if (!existingOwner) {
    await createUser(
      db,
      {
        username: DEMO_OWNER.username,
        displayName: DEMO_OWNER.displayName,
        password: DEMO_OWNER.password,
        role: 'OWNER',
      },
      null,
      now,
    );
  }

  const existingStaff = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, DEMO_STAFF.username))
    .get();

  if (!existingStaff) {
    await createUser(
      db,
      {
        username: DEMO_STAFF.username,
        displayName: DEMO_STAFF.displayName,
        password: DEMO_STAFF.password,
        pin: DEMO_STAFF.pin,
        role: 'STAFF',
        permissions: defaultStaffPermissions(),
      },
      null,
      now,
    );
  }

  // Opening stock is entered through a real adjustment, so the demo data
  // exercises the same path as production and ties back to the ledger.
  const owner = db.select().from(users).where(eq(users.username, DEMO_OWNER.username)).get();
  if (owner) {
    const actor = { id: owner.id, username: owner.username };
    seedDemoCatalog(db, actor, toBusinessDate(now));
    // Purchases first, so deliveries re-average the cost before anything sells.
    seedDemoPurchases(db, actor, toBusinessDate(now));
    // Sales go through the real createSale path, so the demo database
    // exercises stock, COGS and journal posting exactly as production does.
    seedDemoSales(db, actor, toBusinessDate(now));
    seedDemoCashbook(db, actor, toBusinessDate(now));
    // After the sales, because converting one produces a sale and the sales
    // seed refuses to run at all once any sale exists.
    seedDemoQuotations(db, actor, toBusinessDate(now));

    // Give whatever is left on the shelf an opening batch.
    //
    // The migration does this for a shop that already existed, but a demo
    // database is created AFTER it runs: the products above are made here, and
    // their stock moves through the ordinary services — which do not allocate
    // batches yet. Without this step a freshly seeded shop holds stock that no
    // batch owns, and `verifyBatchCoverage` fails on a database nobody has
    // touched.
    //
    // Undated, exactly as the migration leaves real stock: nothing here has a
    // date anybody entered, and inventing one would put a warning, or a refused
    // sale, behind a number nobody chose.
    openOpeningBatches(db, toBusinessDate(now));
  }

  writeTransaction(db, (tx) => {
    /**
     * The demo shop's own name and address, but ONLY if nobody has chosen one.
     *
     * A name somebody typed is a decision, and the seed does not get to
     * overrule it — a person who has named their shop and then runs `db:seed`
     * to get some sample trading should not find it renamed underneath them.
     * `DEFAULT_BUSINESS_NAME` is what the settings row is created with, and
     * this demo name is what a previous run of this seed left, so both are
     * safe to write over.
     */
    const current = tx
      .select({ businessName: businessSettings.businessName })
      .from(businessSettings)
      .where(eq(businessSettings.id, 1))
      .get();

    const named =
      current !== undefined &&
      current.businessName !== DEFAULT_BUSINESS_NAME &&
      current.businessName !== DEMO_BUSINESS_NAME;

    tx.update(businessSettings)
      .set({
        ...(named
          ? {}
          : {
              businessName: DEMO_BUSINESS_NAME,
              tagline: 'Cement, steel, roofing and plumbing',
              address: 'Plot 12, Spintex Road, Accra',
              phone: '+233 24 000 0000',
              /*
                The demo shop IS a building materials yard, so it says so, and
                the features follow from the type exactly as they would if
                somebody had chosen it on the setup screen. A yard demo that
                came up as general retail would hide the Quotations menu the
                seeded quotes below are sitting in.

                Inside the same guard as the name: a shop that has already told
                us what it is does not get overruled by a seed.
              */
              businessType: 'building_materials',
              featureExpiryBatches: DEMO_FEATURES.expiry_batches,
              featureQuotations: DEMO_FEATURES.quotations,
            }),
        hasDemoData: true,
        setupCompletedAt: now,
        updatedAt: now,
      })
      .where(eq(businessSettings.id, 1))
      .run();

    writeAudit(tx, {
      action: 'SEED_DEMO',
      entityType: 'system',
      entityId: 'demo-seed',
      summary: 'Demo data seeded — not for production use',
      at: now,
    });
  });
}
