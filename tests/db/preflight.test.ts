import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runPreflight, type Check } from '@/db/preflight';
import { createTestDatabase, accountIdFor, type TestDatabase } from '../helpers/test-db';
import { postJournalEntry } from '@/services/journal.service';
import { credit, debit } from '@/domain/accounting/journal';
import { minor } from '@/domain/money';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { createUser } from '@/services/auth.service';

let context: TestDatabase;

beforeEach(() => {
  context = createTestDatabase();
});

afterEach(() => {
  context.cleanup();
});

const find = (checks: Check[], name: string): Check => {
  const found = checks.find((check) => check.name === name);
  if (!found) throw new Error(`No preflight check named "${name}". Has it been renamed?`);
  return found;
};

function postBalanced(): void {
  postJournalEntry(
    context.db,
    {
      entryDate: '2026-08-17',
      memo: 'Owner puts money in',
      sourceType: 'OPENING_BALANCE',
      isOpening: true,
      lines: [
        debit(accountIdFor(context.db, '1001'), minor(50000)),
        credit(accountIdFor(context.db, ACCOUNT_CODES.OWNERS_CAPITAL), minor(50000)),
      ],
    },
    null,
  );
}

describe('production preflight', () => {
  it('reports a missing database as a blocker, not a warning', () => {
    const checks = runPreflight('./does/not/exist.db');
    expect(find(checks, 'Database exists').status).toBe('fail');
  });

  it('passes the structural checks on a healthy database', () => {
    postBalanced();
    const checks = runPreflight(context.connection.name);

    expect(find(checks, 'Database is not corrupt').status).toBe('pass');
    expect(find(checks, 'No broken references').status).toBe('pass');
    expect(find(checks, 'Migrations applied').status).toBe('pass');
    expect(find(checks, 'The books balance').status).toBe('pass');
  });

  it('BLOCKS when the books do not balance', () => {
    postBalanced();
    // Exactly the silent corruption a preflight exists to catch.
    context.connection.prepare('UPDATE journal_lines SET credit_minor = credit_minor + 5 WHERE credit_minor > 0').run();

    const check = find(runPreflight(context.connection.name), 'The books balance');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/do NOT trade/i);
  });

  it('BLOCKS when nobody can sign in', () => {
    const check = find(runPreflight(context.connection.name), 'An owner can sign in');
    expect(check.status).toBe('fail');
  });

  it('passes once an active owner exists', async () => {
    await createUser(
      context.db,
      { username: 'kwame', displayName: 'Kwame Owusu', password: 'owner-password-2026', role: 'OWNER' },
      null,
    );
    expect(find(runPreflight(context.connection.name), 'An owner can sign in').status).toBe('pass');
  });

  it('BLOCKS on accounts using the published demo usernames', async () => {
    await createUser(
      context.db,
      { username: 'owner', displayName: 'Demo Owner', password: 'demo-owner-2026', role: 'OWNER' },
      null,
    );

    const check = find(runPreflight(context.connection.name), 'No demo accounts');
    expect(check.status).toBe('fail');
    // The reason must be stated, not just the verdict.
    expect(check.detail).toMatch(/README/);
  });

  it('BLOCKS on demo records left in the books', () => {
    context.connection
      .prepare(
        "INSERT INTO products (sku, name, unit, selling_price_minor, is_demo, created_at, updated_at) VALUES ('DEMO-1', 'Demo Milo', 'tin', 1000, 1, 0, 0)",
      )
      .run();

    const check = find(runPreflight(context.connection.name), 'No demo records in the books');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/1 demo record/);
  });

  it('passes the demo check on a genuinely clean database', () => {
    expect(find(runPreflight(context.connection.name), 'No demo records in the books').status).toBe(
      'pass',
    );
  });
});
