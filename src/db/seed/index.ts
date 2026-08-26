/**
 * Seed runner: `npm run db:seed`.
 *
 * Always applies the idempotent baseline. Applies demo data only when
 * SEED_DEMO_DATA=true, which `env.ts` refuses to accept in production.
 *
 * Demo data is refused outright on a database that already holds real trading.
 * `NODE_ENV=production` protects a live shop, but plenty of databases that
 * matter are not running in production mode — a shop being set up, a copy
 * somebody is checking a figure against — and seeding one of those writes
 * invented sales into records a person is relying on. `--force` is there for
 * when that is genuinely what you want.
 */
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { writeTransaction } from '@/db/transaction';

import * as schema from '@/db/schema';
import { assertDatabaseHealthy, configureConnection } from '@/db/pragmas';
import type { Db } from '@/db/types';
import { assertDemoSeedAllowed, env } from '@/lib/env';
import { seedCore } from './core';
import { DEMO_OWNER, DEMO_STAFF, seedDemo } from './demo';

/** Documents that mean somebody has been trading on this database. */
const TRADING_TABLES = ['sales', 'purchases', 'stock_adjustments', 'journal_entries'] as const;

/**
 * How many records this database holds that the demo seed did not write.
 *
 * Counted from `is_demo`, the same flag `preflight` and the demo purge use, so
 * there is one definition of "real" rather than three.
 */
export function countRealRecords(connection: Database.Database): number {
  let total = 0;
  for (const table of TRADING_TABLES) {
    const row = connection.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE is_demo = 0`).get() as {
      n: number;
    };
    total += row.n;
  }
  return total;
}

export async function runSeed(
  databasePath: string = env.DATABASE_PATH,
  options: { force?: boolean } = {},
): Promise<void> {
  const connection = new Database(resolve(process.cwd(), databasePath));
  configureConnection(connection);

  try {
    const db = drizzle(connection, { schema }) as Db;

    writeTransaction(db, (tx) => {
      seedCore(tx);
    });
    console.log('Baseline seeded: settings, chart of accounts, sequences, payment accounts.');

    if (env.SEED_DEMO_DATA) {
      // Hard stop before a single demo row can be written to a real database.
      assertDemoSeedAllowed();

      const real = countRealRecords(connection);
      if (real > 0 && options.force !== true) {
        throw new Error(
          [
            `Refusing to seed demo data: this database already holds ${real} record(s) that are not demo data.`,
            'Seeding would add invented sales and suppliers alongside them, and would rename the shop.',
            'Re-run with --force if that is genuinely what you want.',
          ].join(' '),
        );
      }
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
  runSeed(env.DATABASE_PATH, { force: process.argv.includes('--force') })
    .then(() => console.log('Seed complete.'))
    .catch((error: unknown) => {
      console.error('Seed failed:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
