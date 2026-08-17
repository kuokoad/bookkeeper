import { eq } from 'drizzle-orm';

import type { Db } from '@/db/types';
import { businessSettings, users } from '@/db/schema';
import { createUser } from '@/services/auth.service';
import { defaultStaffPermissions } from '@/lib/auth/permissions';
import { writeAudit } from '@/services/audit.service';
import { toBusinessDate } from '@/lib/format';
import { seedDemoCatalog } from './demo-catalog';
import { seedDemoPurchases } from './demo-purchases';
import { seedDemoSales } from './demo-sales';
import { seedDemoCashbook } from './demo-cashbook';

/**
 * Development-only demo data.
 *
 * Guarded twice: `env.ts` refuses to start production with SEED_DEMO_DATA=true,
 * and every row written here is marked so it can be purged. The credentials
 * below are published in the README precisely because they must never exist on
 * a real shop's machine.
 */

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
  }

  db.transaction((tx) => {
    tx.update(businessSettings)
      .set({
        businessName: 'Adom Provisions',
        address: 'Shop 4, Madina Market, Accra',
        phone: '+233 24 000 0000',
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
