/**
 * Seed runner: `npm run db:seed`.
 *
 * Always applies the idempotent baseline. Applies demo data only when
 * SEED_DEMO_DATA=true, which `env.ts` refuses to accept in production.
 */
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import * as schema from '@/db/schema';
import { assertDatabaseHealthy, configureConnection } from '@/db/pragmas';
import type { Db } from '@/db/types';
import { assertDemoSeedAllowed, env } from '@/lib/env';
import { seedCore } from './core';
import { DEMO_OWNER, DEMO_STAFF, seedDemo } from './demo';

export async function runSeed(databasePath: string = env.DATABASE_PATH): Promise<void> {
  const connection = new Database(resolve(process.cwd(), databasePath));
  configureConnection(connection);

  try {
    const db = drizzle(connection, { schema }) as Db;

    db.transaction((tx) => {
      seedCore(tx);
    });
    console.log('Baseline seeded: settings, chart of accounts, sequences, payment accounts.');

    if (env.SEED_DEMO_DATA) {
      // Hard stop before a single demo row can be written to a real database.
      assertDemoSeedAllowed();
      await seedDemo(db);
      console.log('Demo data seeded.');
      console.log(`  Owner  ->  ${DEMO_OWNER.username} / ${DEMO_OWNER.password}`);
      console.log(`  Staff  ->  ${DEMO_STAFF.username} / ${DEMO_STAFF.password} (PIN ${DEMO_STAFF.pin})`);
      console.warn('  These are DEMO credentials. Never use them on a real shop database.');
    }

    assertDatabaseHealthy(connection);
  } finally {
    connection.close();
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url.replace(/\\/g, '/').endsWith(entry.replace(/\\/g, '/').split('/').pop() ?? '');
}

if (isDirectRun()) {
  runSeed()
    .then(() => console.log('Seed complete.'))
    .catch((error: unknown) => {
      console.error('Seed failed:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
