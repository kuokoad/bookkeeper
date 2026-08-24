import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { configureConnection } from '@/db/pragmas';
import { writeTransaction } from '@/db/transaction';

/**
 * Why every write opens with `BEGIN IMMEDIATE`.
 *
 * SQLite's default is `BEGIN DEFERRED`, which takes no lock until it has to. It
 * reads first — taking a snapshot — and asks for the write lock later. In WAL
 * mode, if another connection commits in between, that upgrade CANNOT be
 * granted: SQLITE_BUSY_SNAPSHOT, and `busy_timeout` cannot help, because no
 * amount of waiting rescues a snapshot that has already been overtaken.
 *
 * These tests use two real connections to one file to show both halves: the
 * failure the default produces, and that opening immediately removes it.
 *
 * A single-process deployment never sees either, because better-sqlite3 is
 * synchronous and two transactions cannot be open at once. That is a property of
 * how the app is DEPLOYED, not of the code, and it disappears the moment anyone
 * forks workers or opens a second connection to take a backup mid-trading.
 */

let context: TestDatabase;
let other: Database.Database;

/** A second connection to the same file, impatient so the test stays quick. */
function secondConnection(path: string): Database.Database {
  const connection = new Database(path);
  configureConnection(connection);
  connection.pragma('busy_timeout = 50');
  return connection;
}

function insertProduct(connection: Database.Database, name: string) {
  connection
    .prepare(
      `INSERT INTO products (name, unit, cost_price_minor, selling_price_minor, track_inventory,
                             qty_on_hand_milli, stock_value_minor, created_at, updated_at)
       VALUES (?, 'pcs', 100, 200, 1, 0, 0, ?, ?)`,
    )
    .run(name, Date.now(), Date.now());
}

beforeEach(() => {
  context = createTestDatabase();
  other = secondConnection(context.connection.name);
});

afterEach(() => {
  other.close();
  context.cleanup();
});

describe('the failure BEGIN DEFERRED produces', () => {
  it('cannot upgrade a read snapshot once another connection has committed', () => {
    const ours = context.connection;

    ours.prepare('BEGIN DEFERRED').run();
    try {
      // Read first — this is what takes the snapshot, and it is what every one
      // of this application's transactions does before it writes anything.
      ours.prepare('SELECT COUNT(*) AS c FROM products').get();

      // Somebody else commits while we are thinking.
      insertProduct(other, 'Sold by the other till');

      // Now we try to write. There is no waiting our way out of this one.
      expect(() => insertProduct(ours, 'Ours')).toThrow(/SQLITE_BUSY|snapshot|locked/i);
    } finally {
      try {
        ours.prepare('ROLLBACK').run();
      } catch {
        // Already rolled back by the failure above; nothing to undo.
      }
    }
  });
});

describe('what BEGIN IMMEDIATE does instead', () => {
  it('takes the write lock at the start, so the OTHER writer is the one that waits', () => {
    let sawTheLockHeld = false;

    writeTransaction(context.db, (tx) => {
      // We have written nothing yet. Under BEGIN DEFERRED no lock would be held
      // at this point and the line below would succeed — which is precisely how
      // the snapshot above got overtaken.
      expect(() => insertProduct(other, 'Sold by the other till')).toThrow(
        /SQLITE_BUSY|locked/i,
      );
      sawTheLockHeld = true;

      // Plain SQL keeps this test about locking rather than about the schema.
      tx.run(sql`
        INSERT INTO products (name, unit, cost_price_minor, selling_price_minor,
                              track_inventory, qty_on_hand_milli, stock_value_minor,
                              created_at, updated_at)
        VALUES ('Ours', 'pcs', 100, 200, 1, 0, 0, 0, 0)
      `);
    });

    expect(sawTheLockHeld).toBe(true);

    const ours = context.connection
      .prepare("SELECT COUNT(*) AS c FROM products WHERE name = 'Ours'")
      .get() as { c: number };
    expect(ours.c).toBe(1);
  });

  it('still rolls the whole thing back when the work throws', () => {
    const before = (
      context.connection.prepare('SELECT COUNT(*) AS c FROM products').get() as { c: number }
    ).c;

    expect(() =>
      writeTransaction(context.db, () => {
        insertProduct(context.connection, 'Half a sale');
        throw new Error('something went wrong after the write');
      }),
    ).toThrow('something went wrong after the write');

    const after = (
      context.connection.prepare('SELECT COUNT(*) AS c FROM products').get() as { c: number }
    ).c;
    expect(after).toBe(before);
  });
});

describe('no service opens a transaction of its own', () => {
  /**
   * The behaviour above is only true if every write goes through the helper.
   * Read from the source, like the other structural tests, so a new service —
   * or a refactor of an old one — cannot quietly reintroduce the default.
   */
  const serviceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? serviceFiles(join(dir, entry.name))
        : entry.name.endsWith('.ts')
          ? [join(dir, entry.name)]
          : [],
    );

  it('every write goes through writeTransaction', () => {
    const offenders = serviceFiles(join(process.cwd(), 'src', 'services'))
      .filter((file) => /\bdb\.transaction\(|\btx\.transaction\(/.test(readFileSync(file, 'utf8')))
      .map((file) => file.replace(process.cwd(), ''));

    expect(offenders).toEqual([]);
  });

  it('and the helper is the only place the behaviour is set', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'db', 'transaction.ts'), 'utf8');
    expect(source).toContain("behavior: 'immediate'");
  });
});
