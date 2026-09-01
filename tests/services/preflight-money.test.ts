import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runPreflight } from '@/db/preflight';
import { createTestDatabase, accountIdFor, type TestDatabase } from '../helpers/test-db';
import { postJournalEntry } from '@/services/journal.service';
import { credit, debit } from '@/domain/accounting/journal';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { minor } from '@/domain/money';

/**
 * The money figures in the readiness checks.
 *
 * `runPreflight` is read twice: by a developer at a terminal, and by a shop
 * owner on the Health screen, which renders exactly these strings. It printed
 * `(debits / 100).toFixed(2)` — a float division with no grouping — and, in the
 * branch that fires when the books are BROKEN, raw minor units. So the one
 * message telling an owner their books do not balance reported the size of the
 * hole a hundred times too large.
 */

let context: TestDatabase;

beforeEach(() => {
  context = createTestDatabase();
});

afterEach(() => {
  context.cleanup();
});

const account = (code: string) => accountIdFor(context.db, code);

/** `connection.name` is the file better-sqlite3 opened, which preflight reopens. */
const booksCheck = () =>
  runPreflight(context.connection.name).find((check) => check.name === 'The books balance');

describe('the readiness check that reports the books', () => {
  it('writes a balanced total as money, grouped, not as a raw division', () => {
    postJournalEntry(
      context.db,
      {
        entryDate: '2026-08-20',
        memo: 'opening',
        sourceType: 'OPENING_BALANCE',
        isOpening: true,
        lines: [
          debit(account('1001'), minor(1_234_567_89)),
          credit(account(ACCOUNT_CODES.OWNERS_CAPITAL), minor(1_234_567_89)),
        ],
      },
      null,
    );

    const check = booksCheck();

    expect(check?.status).toBe('pass');
    expect(check?.detail).toBe('debits and credits both 1,234,567.89');
  });

  /**
   * The branch that matters most, and the one that was worst. A shop whose
   * books are out by GHS 6,000.00 was told "debits 60255281 vs credits
   * 59655281" — two numbers nobody can read, in the message that decides
   * whether they keep trading.
   */
  it('writes an unbalanced pair as money, and names the difference', () => {
    // Written straight to the table: `postJournalEntry` will not let an
    // unbalanced entry exist, which is the point of it.
    context.connection
      .prepare(
        `INSERT INTO journal_entries (id, entry_no, entry_date, occurred_at, memo, source_type, created_at)
         VALUES (9001, 'JE-09001', '2026-08-20', 0, 'broken', 'OPENING_BALANCE', 0)`,
      )
      .run();
    context.connection
      .prepare(
        `INSERT INTO journal_lines (entry_id, account_id, debit_minor, credit_minor, line_no)
         VALUES (9001, ?, 600000, 0, 1)`,
      )
      .run(account('1001'));

    const check = booksCheck();

    expect(check?.status).toBe('fail');
    expect(check?.detail).toContain('debits 6,000.00');
    expect(check?.detail).toContain('credits 0.00');
    expect(check?.detail).toContain('a difference of 6,000.00');
    expect(check?.detail).toContain('Do NOT trade on these books');

    // The thing that was actually wrong: never the stored pesewas.
    expect(check?.detail).not.toContain('600000');
  });
});
