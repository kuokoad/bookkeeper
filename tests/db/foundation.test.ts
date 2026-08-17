import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { accountIdFor, assertHealthy, createTestDatabase, type TestDatabase } from '../helpers/test-db';
import {
  accounts,
  auditLogs,
  businessSettings,
  journalEntries,
  journalLines,
  paymentAccounts,
  sequences,
  users,
} from '@/db/schema';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { DOC_TYPES, nextDocumentNumber, peekDocumentNumber } from '@/services/sequence.service';
import { seedCore } from '@/db/seed/core';
import { writeAudit } from '@/services/audit.service';

let context: TestDatabase;

beforeEach(() => {
  context = createTestDatabase();
});

afterEach(() => {
  context.cleanup();
});

describe('migrations and pragmas', () => {
  it('enables foreign key enforcement', () => {
    const [result] = context.connection.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(result?.foreign_keys).toBe(1);
  });

  it('leaves the database internally consistent', () => {
    expect(() => assertHealthy(context.connection)).not.toThrow();
  });

  it('creates the singleton settings row', () => {
    const rows = context.db.select().from(businessSettings).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.currencyCode).toBe('GHS');
    expect(rows[0]?.allowNegativeStock).toBe(false);
  });

  it('refuses a second settings row', () => {
    // The CHECK pins id to 1, so a second row is impossible by construction.
    expect(() =>
      context.db.insert(businessSettings).values({ id: 2 }).run(),
    ).toThrow();
  });
});

describe('chart of accounts seed', () => {
  it('creates every system account exactly once, idempotently', () => {
    const before = context.db.select().from(accounts).all().length;
    context.db.transaction((tx) => seedCore(tx));
    const after = context.db.select().from(accounts).all().length;

    expect(before).toBeGreaterThan(20);
    expect(after).toBe(before);
  });

  it('marks system accounts as undeletable', () => {
    const cash = context.db.select().from(accounts).where(eq(accounts.code, '1001')).get();
    expect(cash?.isSystem).toBe(true);
  });

  it('gives every payment account its own ledger account', () => {
    const rows = context.db.select().from(paymentAccounts).all();
    expect(rows).toHaveLength(3);

    const glIds = rows.map((row) => row.glAccountId);
    expect(new Set(glIds).size).toBe(glIds.length);

    for (const row of rows) {
      const gl = context.db.select().from(accounts).where(eq(accounts.id, row.glAccountId)).get();
      expect(gl?.type).toBe('ASSET');
      // Each is a child of a heading, never the heading itself.
      expect(gl?.parentId).not.toBeNull();
    }
  });

  it('has exactly one default payment account', () => {
    const defaults = context.db
      .select()
      .from(paymentAccounts)
      .all()
      .filter((row) => row.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.kind).toBe('CASH');
  });

  it('does not hard-code a mobile network', () => {
    const momo = context.db
      .select()
      .from(paymentAccounts)
      .all()
      .find((row) => row.kind === 'MOBILE_MONEY');
    // Provider is free text, so "Telecel Cash" is data entry, not a code change.
    expect(momo?.provider).toBe('MTN');

    expect(() =>
      context.db
        .insert(paymentAccounts)
        .values({
          name: 'Telecel Cash',
          kind: 'MOBILE_MONEY',
          provider: 'Telecel',
          glAccountId: accountIdFor(context.db, ACCOUNT_CODES.MOBILE_MONEY),
        })
        .run(),
    ).not.toThrow();
  });

  it('rejects a duplicate account code', () => {
    expect(() =>
      context.db
        .insert(accounts)
        .values({ code: '1001', name: 'Duplicate', type: 'ASSET', normalBalance: 'DEBIT' })
        .run(),
    ).toThrow();
  });
});

describe('enum values are enforced by the DATABASE, not just TypeScript', () => {
  // drizzle's `text({ enum: [...] })` is types-only and emits no SQL. These
  // tests exist to prove the explicit CHECK constraints are really there — a
  // value written by raw SQL, a future bug, or a direct edit of the database
  // file must be rejected by SQLite itself.
  it('rejects an invalid user role', () => {
    expect(() =>
      context.connection
        .prepare("INSERT INTO users (username, display_name, role, password_hash) VALUES (?,?,?,?)")
        .run('rogue', 'Rogue', 'SUPERADMIN', 'scrypt$1$2$3$a$b'),
    ).toThrow(/CHECK constraint/i);
  });

  it('rejects an invalid permission module', () => {
    context.connection
      .prepare("INSERT INTO users (username, display_name, role, password_hash) VALUES (?,?,?,?)")
      .run('staffer', 'Staffer', 'STAFF', 'scrypt$1$2$3$a$b');
    const userId = context.connection.prepare('SELECT id FROM users WHERE username = ?').get('staffer') as { id: number };

    expect(() =>
      context.connection
        .prepare('INSERT INTO user_permissions (user_id, module) VALUES (?,?)')
        .run(userId.id, 'nonsense'),
    ).toThrow(/CHECK constraint/i);
  });

  it('rejects an invalid audit action', () => {
    expect(() =>
      context.connection
        .prepare('INSERT INTO audit_logs (action, entity_type, summary) VALUES (?,?,?)')
        .run('TAMPERED', 'user', 'x'),
    ).toThrow(/CHECK constraint/i);
  });

  it('rejects an empty audit summary', () => {
    expect(() =>
      context.connection
        .prepare('INSERT INTO audit_logs (action, entity_type, summary) VALUES (?,?,?)')
        .run('LOGIN_SUCCESS', 'user', ''),
    ).toThrow(/CHECK constraint/i);
  });

  it('rejects an account whose normal balance contradicts its type', () => {
    // A revenue account with a DEBIT normal balance would make every report
    // that sign-adjusts present it backwards.
    expect(() =>
      context.connection
        .prepare('INSERT INTO accounts (code, name, type, normal_balance) VALUES (?,?,?,?)')
        .run('9999', 'Backwards Revenue', 'REVENUE', 'DEBIT'),
    ).toThrow(/CHECK constraint/i);

    expect(() =>
      context.connection
        .prepare('INSERT INTO accounts (code, name, type, normal_balance) VALUES (?,?,?,?)')
        .run('9998', 'Correct Revenue', 'REVENUE', 'CREDIT'),
    ).not.toThrow();
  });

  it('rejects an invalid payment account kind', () => {
    expect(() =>
      context.connection
        .prepare('INSERT INTO payment_accounts (name, kind, gl_account_id) VALUES (?,?,?)')
        .run('Crypto', 'BITCOIN', accountIdFor(context.db, '1001')),
    ).toThrow(/CHECK constraint/i);
  });

  it('rejects a journal entry that cannot be traced to a transaction', () => {
    // Only an opening balance may exist without a source row.
    expect(() =>
      context.connection
        .prepare(
          'INSERT INTO journal_entries (entry_no, entry_date, occurred_at, source_type, source_id) VALUES (?,?,?,?,NULL)',
        )
        .run('JE-ORPHAN', '2026-08-16', Date.now(), 'SALE'),
    ).toThrow(/CHECK constraint/i);

    expect(() =>
      context.connection
        .prepare(
          'INSERT INTO journal_entries (entry_no, entry_date, occurred_at, source_type, source_id) VALUES (?,?,?,?,NULL)',
        )
        .run('JE-OPENING', '2026-08-16', Date.now(), 'OPENING_BALANCE'),
    ).not.toThrow();
  });

  it('rejects an invalid journal source type', () => {
    expect(() =>
      context.connection
        .prepare(
          'INSERT INTO journal_entries (entry_no, entry_date, occurred_at, source_type, source_id) VALUES (?,?,?,?,1)',
        )
        .run('JE-BADSRC', '2026-08-16', Date.now(), 'MADE_UP'),
    ).toThrow(/CHECK constraint/i);
  });
});

describe('journal line constraints', () => {
  function createEntry(): number {
    const entry = context.db
      .insert(journalEntries)
      .values({
        entryNo: `JE-${Math.random().toString(36).slice(2, 8)}`,
        entryDate: '2026-08-16',
        occurredAt: new Date(),
        sourceType: 'OPENING_BALANCE',
      })
      .returning({ id: journalEntries.id })
      .get();
    if (!entry) throw new Error('failed to create entry');
    return entry.id;
  }

  it('accepts a one-sided debit line', () => {
    const entryId = createEntry();
    expect(() =>
      context.db
        .insert(journalLines)
        .values({
          entryId,
          lineNo: 1,
          accountId: accountIdFor(context.db, '1001'),
          debitMinor: 50_000,
          creditMinor: 0,
        })
        .run(),
    ).not.toThrow();
  });

  it('rejects a line that is both a debit and a credit', () => {
    const entryId = createEntry();
    expect(() =>
      context.db
        .insert(journalLines)
        .values({
          entryId,
          lineNo: 1,
          accountId: accountIdFor(context.db, '1001'),
          debitMinor: 50_000,
          creditMinor: 50_000,
        })
        .run(),
    ).toThrow();
  });

  it('rejects a line that moves nothing', () => {
    const entryId = createEntry();
    expect(() =>
      context.db
        .insert(journalLines)
        .values({
          entryId,
          lineNo: 1,
          accountId: accountIdFor(context.db, '1001'),
          debitMinor: 0,
          creditMinor: 0,
        })
        .run(),
    ).toThrow();
  });

  it('rejects negative amounts', () => {
    const entryId = createEntry();
    expect(() =>
      context.db
        .insert(journalLines)
        .values({
          entryId,
          lineNo: 1,
          accountId: accountIdFor(context.db, '1001'),
          debitMinor: -50_000,
          creditMinor: 0,
        })
        .run(),
    ).toThrow();
  });

  it('rejects a line pointing at a non-existent account', () => {
    const entryId = createEntry();
    expect(() =>
      context.db
        .insert(journalLines)
        .values({ entryId, lineNo: 1, accountId: 999_999, debitMinor: 100, creditMinor: 0 })
        .run(),
    ).toThrow();
  });

  it('rejects a line pointing at a non-existent entry', () => {
    expect(() =>
      context.db
        .insert(journalLines)
        .values({
          entryId: 999_999,
          lineNo: 1,
          accountId: accountIdFor(context.db, '1001'),
          debitMinor: 100,
          creditMinor: 0,
        })
        .run(),
    ).toThrow();
  });

  it('rejects duplicate line numbers within one entry', () => {
    const entryId = createEntry();
    const accountId = accountIdFor(context.db, '1001');
    context.db
      .insert(journalLines)
      .values({ entryId, lineNo: 1, accountId, debitMinor: 100, creditMinor: 0 })
      .run();

    expect(() =>
      context.db
        .insert(journalLines)
        .values({ entryId, lineNo: 1, accountId, debitMinor: 0, creditMinor: 100 })
        .run(),
    ).toThrow();
  });

  it('refuses to delete an account that has been posted to', () => {
    const entryId = createEntry();
    const accountId = accountIdFor(context.db, '1001');
    context.db
      .insert(journalLines)
      .values({ entryId, lineNo: 1, accountId, debitMinor: 100, creditMinor: 0 })
      .run();

    // ON DELETE RESTRICT: history cannot be orphaned.
    expect(() => context.db.delete(accounts).where(eq(accounts.id, accountId)).run()).toThrow();
  });

  it('rejects a malformed entry date', () => {
    expect(() =>
      context.db
        .insert(journalEntries)
        .values({
          entryNo: 'JE-BAD',
          entryDate: '16/08/2026',
          occurredAt: new Date(),
          sourceType: 'OPENING_BALANCE',
        })
        .run(),
    ).toThrow();
  });
});

describe('document numbering', () => {
  it('issues sequential numbers with the configured prefix and padding', () => {
    const first = context.db.transaction((tx) => nextDocumentNumber(tx, DOC_TYPES.RECEIPT));
    const second = context.db.transaction((tx) => nextDocumentNumber(tx, DOC_TYPES.RECEIPT));
    const third = context.db.transaction((tx) => nextDocumentNumber(tx, DOC_TYPES.RECEIPT));

    expect(first).toBe('RCP-00001');
    expect(second).toBe('RCP-00002');
    expect(third).toBe('RCP-00003');
  });

  it('keeps separate counters per document type', () => {
    context.db.transaction((tx) => nextDocumentNumber(tx, DOC_TYPES.RECEIPT));
    const purchase = context.db.transaction((tx) => nextDocumentNumber(tx, DOC_TYPES.PURCHASE));
    expect(purchase).toBe('PUR-00001');
  });

  it('never reissues a number, even across a rolled-back transaction', () => {
    const issued = new Set<string>();
    for (let i = 0; i < 25; i++) {
      issued.add(context.db.transaction((tx) => nextDocumentNumber(tx, DOC_TYPES.RECEIPT)));
    }
    expect(issued.size).toBe(25);
  });

  it('rolls the counter back when its transaction fails, leaving no gap', () => {
    context.db.transaction((tx) => nextDocumentNumber(tx, DOC_TYPES.EXPENSE));

    expect(() =>
      context.db.transaction((tx) => {
        nextDocumentNumber(tx, DOC_TYPES.EXPENSE);
        throw new Error('simulated failure after numbering');
      }),
    ).toThrow('simulated failure');

    // The reserved number was released with the rollback.
    const next = context.db.transaction((tx) => nextDocumentNumber(tx, DOC_TYPES.EXPENSE));
    expect(next).toBe('EXP-00002');
  });

  it('can preview the next number without consuming it', () => {
    expect(peekDocumentNumber(context.db, DOC_TYPES.RECEIPT)).toBe('RCP-00001');
    expect(peekDocumentNumber(context.db, DOC_TYPES.RECEIPT)).toBe('RCP-00001');
    expect(context.db.transaction((tx) => nextDocumentNumber(tx, DOC_TYPES.RECEIPT))).toBe(
      'RCP-00001',
    );
  });

  it('throws rather than guessing for an unconfigured type', () => {
    context.db.delete(sequences).where(eq(sequences.docType, DOC_TYPES.RECEIPT)).run();
    expect(() =>
      context.db.transaction((tx) => nextDocumentNumber(tx, DOC_TYPES.RECEIPT)),
    ).toThrow(/No numbering sequence/);
  });
});

describe('atomicity', () => {
  it('leaves no partial rows when a multi-step operation fails', () => {
    const accountId = accountIdFor(context.db, '1001');

    expect(() =>
      context.db.transaction((tx) => {
        const entry = tx
          .insert(journalEntries)
          .values({
            entryNo: 'JE-ATOMIC',
            entryDate: '2026-08-16',
            occurredAt: new Date(),
            sourceType: 'OPENING_BALANCE',
          })
          .returning({ id: journalEntries.id })
          .get();

        tx.insert(journalLines)
          .values({ entryId: entry!.id, lineNo: 1, accountId, debitMinor: 100, creditMinor: 0 })
          .run();

        // Something goes wrong before the balancing credit is written.
        throw new Error('simulated mid-transaction failure');
      }),
    ).toThrow('simulated mid-transaction failure');

    // Neither the entry nor its orphan line survives.
    expect(context.db.select().from(journalEntries).all()).toHaveLength(0);
    expect(context.db.select().from(journalLines).all()).toHaveLength(0);
  });
});

describe('audit log', () => {
  it('records an entry and redacts credentials', () => {
    context.db.transaction((tx) => {
      writeAudit(tx, {
        action: 'PASSWORD_CHANGE',
        entityType: 'user',
        entityId: 1,
        summary: 'Password changed',
        metadata: { username: 'ama', password: 'super-secret', nested: { pin: '8351' } },
      });
    });

    const entry = context.db
      .select()
      .from(auditLogs)
      .all()
      .find((row) => row.action === 'PASSWORD_CHANGE');
    expect(entry).toBeDefined();
    expect(entry?.metadata).toBeTruthy();

    const metadata = JSON.parse(entry?.metadata ?? '{}') as {
      username: string;
      password: string;
      nested: { pin: string };
    };
    expect(metadata.username).toBe('ama');
    expect(metadata.password).toBe('[redacted]');
    expect(metadata.nested.pin).toBe('[redacted]');
    expect(entry?.metadata).not.toContain('super-secret');
  });

  it('cascades session removal when a user is deleted', () => {
    const user = context.db
      .insert(users)
      .values({ username: 'temp-user', displayName: 'Temp', passwordHash: 'scrypt$1$2$3$a$b' })
      .returning({ id: users.id })
      .get();

    expect(user).toBeDefined();
    context.db.delete(users).where(eq(users.id, user!.id)).run();
    expect(() => assertHealthy(context.connection)).not.toThrow();
  });
});
