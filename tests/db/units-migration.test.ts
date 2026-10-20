import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { configureConnection } from '@/db/pragmas';
import { assertHealthy } from '../helpers/test-db';

/**
 * Upgrading a shop that already has products with typed-in units.
 *
 * Runs the real migrations up to the one before units existed, puts in the
 * kind of data a real shop has — the same unit spelled two ways, a weighed
 * product holding a fraction — then applies the units migration on top.
 */

const MIGRATIONS = resolve(process.cwd(), 'src/db/migrations');
const UNITS_MIGRATION = '0025_units_of_measure';

let directory = '';

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function migrateTo(connection: Database.Database, folder: string) {
  connection.pragma('foreign_keys = OFF');
  try {
    migrate(drizzle(connection), { migrationsFolder: folder });
  } finally {
    connection.pragma('foreign_keys = ON');
  }
}

describe('the units migration on a shop with products', () => {
  it('turns typed units into one Units entry each and keeps every figure', () => {
    directory = mkdtempSync(join(tmpdir(), 'bookkeeper-units-'));

    // Every migration before units, and nothing after.
    const before = join(directory, 'before');
    cpSync(MIGRATIONS, before, { recursive: true });
    const journalPath = join(before, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    const cut = journal.entries.findIndex((entry) => entry.tag === UNITS_MIGRATION);
    expect(cut).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, cut);
    writeFileSync(journalPath, JSON.stringify(journal));

    const connection = new Database(join(directory, 'shop.db'));
    configureConnection(connection);
    migrateTo(connection, before);

    const insert = connection.prepare(
      `INSERT INTO products (name, unit, cost_price_minor, selling_price_minor, qty_on_hand_milli, stock_value_minor, created_at, updated_at)
       VALUES (?, ?, 100, 200, ?, ?, 0, 0)`,
    );
    insert.run('Milo', 'pcs', 5_000, 500);
    insert.run('Bournvita', ' Pcs ', 3_000, 300);
    insert.run('Rice', 'kg', 2_500, 250);
    // A service: never stocked, so it has no ledger rows, but it was sold by
    // the half hour. Only the sale line shows that 'hour' needs decimals.
    const labour = insert.run('Labour', 'hour', 0, 0).lastInsertRowid;
    const sale = connection
      .prepare(
        `INSERT INTO sales (receipt_no, business_date, occurred_at, subtotal_minor, total_minor)
         VALUES ('RCT-1', '2026-08-01', 0, 1500, 1500)`,
      )
      .run().lastInsertRowid;
    connection
      .prepare(
        `INSERT INTO sale_items (sale_id, line_no, product_id, product_name, unit, qty_milli, unit_price_minor, line_total_minor)
         VALUES (?, 1, ?, 'Labour', 'hour', 1500, 1000, 1500)`,
      )
      .run(sale, labour);

    migrateTo(connection, MIGRATIONS);
    assertHealthy(connection);

    const units = connection
      .prepare('SELECT symbol, decimal_places AS dp FROM units ORDER BY lower(symbol)')
      .all() as { symbol: string; dp: number }[];
    // 'pcs' and ' Pcs ' are one unit; rice holds 2.5 kg and labour was sold
    // by the half hour, so both keep their decimals.
    expect(units).toEqual([
      { symbol: 'hour', dp: 3 },
      { symbol: 'kg', dp: 3 },
      { symbol: 'Pcs', dp: 0 },
    ]);

    const rows = connection
      .prepare('SELECT name, unit, qty_on_hand_milli AS qty, stock_value_minor AS value FROM products ORDER BY id')
      .all();
    expect(rows).toEqual([
      { name: 'Milo', unit: 'Pcs', qty: 5_000, value: 500 },
      { name: 'Bournvita', unit: 'Pcs', qty: 3_000, value: 300 },
      { name: 'Rice', unit: 'kg', qty: 2_500, value: 250 },
      { name: 'Labour', unit: 'hour', qty: 0, value: 0 },
    ]);

    connection.close();
  });
});
