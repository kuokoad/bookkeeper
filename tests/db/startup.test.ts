import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runStartupMigrations } from '@/db/startup';

/**
 * The managed-host path: no terminal, so the server prepares its own database
 * on start. If this is wrong, the shop's first sale hits a missing table.
 */

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bookkeeper-startup-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const open = (file: string) => new Database(file, { readonly: true });

describe('preparing the database at server start', () => {
  it('builds a working database from nothing', async () => {
    const file = join(directory, 'shop.db');
    expect(existsSync(file)).toBe(false);

    await runStartupMigrations(file);

    expect(existsSync(file)).toBe(true);
    const db = open(file);
    try {
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      ).map((row) => row.name);

      // The tables a sale cannot be recorded without.
      for (const table of ['journal_entries', 'journal_lines', 'accounts', 'business_settings']) {
        expect(tables, table).toContain(table);
      }
    } finally {
      db.close();
    }
  });

  it('creates the directory when it does not exist yet', async () => {
    // On a managed host the database lives outside the deployed folder, which
    // will not exist on a first deploy.
    const file = join(directory, 'nested', 'deeper', 'shop.db');
    await runStartupMigrations(file);
    expect(existsSync(file)).toBe(true);
  });

  it('seeds the chart of accounts, so something can actually be posted', async () => {
    const file = join(directory, 'shop.db');
    await runStartupMigrations(file);

    const db = open(file);
    try {
      const { count } = db.prepare('SELECT COUNT(*) AS count FROM accounts').get() as {
        count: number;
      };
      expect(count).toBeGreaterThan(10);

      const settings = db.prepare('SELECT COUNT(*) AS count FROM business_settings').get() as {
        count: number;
      };
      expect(settings.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it('adds NO demo data — that is a separate command', async () => {
    const file = join(directory, 'shop.db');
    await runStartupMigrations(file);

    const db = open(file);
    try {
      const { count } = db.prepare('SELECT COUNT(*) AS count FROM products').get() as {
        count: number;
      };
      expect(count).toBe(0);

      const users = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
      // No accounts either: the first owner is created through the setup screen.
      expect(users.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('is safe to run again on every restart', async () => {
    const file = join(directory, 'shop.db');
    await runStartupMigrations(file);

    // Put something in the books, then restart twice.
    const write = new Database(file);
    write.prepare("UPDATE business_settings SET business_name = 'Adom Provisions' WHERE id = 1").run();
    write.close();

    await runStartupMigrations(file);
    await runStartupMigrations(file);

    const db = open(file);
    try {
      const settings = db.prepare('SELECT business_name FROM business_settings WHERE id = 1').get() as {
        business_name: string;
      };
      // A restart must never reset the shop to defaults.
      expect(settings.business_name).toBe('Adom Provisions');

      const accounts = db.prepare('SELECT COUNT(*) AS count FROM accounts').get() as {
        count: number;
      };
      const settingsRows = db.prepare('SELECT COUNT(*) AS count FROM business_settings').get() as {
        count: number;
      };
      // Nor duplicate what it seeded the first time.
      expect(settingsRows.count).toBe(1);
      expect(accounts.count).toBeGreaterThan(10);
    } finally {
      db.close();
    }
  });

  it('leaves the database usable with foreign keys enforced', async () => {
    const file = join(directory, 'shop.db');
    await runStartupMigrations(file);

    const db = new Database(file);
    try {
      db.pragma('foreign_keys = ON');
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect((db.pragma('integrity_check') as { integrity_check: string }[])[0]?.integrity_check).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('refuses to start rather than serving a half-built schema', async () => {
    // A file that is not a database at all.
    const file = join(directory, 'not-a-database.db');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, 'this is not a database');

    await expect(runStartupMigrations(file)).rejects.toThrow();
  });
});
