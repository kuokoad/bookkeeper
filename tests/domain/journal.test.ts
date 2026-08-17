import { describe, expect, it } from 'vitest';
import {
  assertBalanced,
  assertLinesWellFormed,
  credit,
  debit,
  dropZeroLines,
  finaliseLines,
  normalBalanceOf,
  postSigned,
  reverseLines,
  signedBalance,
  totalCredits,
  totalDebits,
  type DraftLine,
} from '@/domain/accounting/journal';
import { minor, ZERO, type Minor } from '@/domain/money';
import { UnbalancedEntryError, ValidationError } from '@/domain/errors';
import {
  ACCOUNT_CODES,
  isBalanceSheetAccount,
  isProfitAndLossAccount,
  normalBalanceFor,
  SYSTEM_ACCOUNTS,
} from '@/domain/accounting/chart-of-accounts';
import type { AccountType } from '@/db/schema/accounting';

const m = (n: number): Minor => minor(n);

const CASH = 1;
const SALES = 2;
const COGS = 3;
const INVENTORY = 4;
const RECEIVABLE = 5;

describe('line construction', () => {
  it('builds one-sided lines', () => {
    expect(debit(CASH, m(50_000))).toEqual({ accountId: CASH, debit: 50_000, credit: 0 });
    expect(credit(SALES, m(50_000))).toEqual({ accountId: SALES, debit: 0, credit: 50_000 });
  });

  it('refuses negative amounts rather than flipping them silently', () => {
    expect(() => debit(CASH, m(-1))).toThrow(ValidationError);
    expect(() => credit(SALES, m(-1))).toThrow(ValidationError);
  });

  it('postSigned routes by sign', () => {
    expect(postSigned(CASH, m(500)).debit).toBe(500);
    expect(postSigned(CASH, m(500)).credit).toBe(0);
    expect(postSigned(CASH, m(-500)).credit).toBe(500);
    expect(postSigned(CASH, m(-500)).debit).toBe(0);
    expect(postSigned(CASH, ZERO).debit).toBe(0);
  });

  it('carries optional metadata through', () => {
    const line = debit(CASH, m(100), { paymentAccountId: 7, description: 'Till' });
    expect(line.paymentAccountId).toBe(7);
    expect(line.description).toBe('Till');
  });
});

describe('assertBalanced', () => {
  it('accepts a balanced cash sale', () => {
    const lines = [debit(CASH, m(50_000)), credit(SALES, m(50_000))];
    expect(() => assertBalanced(lines)).not.toThrow();
    expect(totalDebits(lines)).toBe(50_000);
    expect(totalCredits(lines)).toBe(50_000);
  });

  it('accepts a multi-line credit sale with COGS', () => {
    // GHS 500 sale, GHS 200 paid now, GHS 300 on credit, goods cost GHS 320.
    const lines = [
      debit(CASH, m(20_000)),
      debit(RECEIVABLE, m(30_000)),
      credit(SALES, m(50_000)),
      debit(COGS, m(32_000)),
      credit(INVENTORY, m(32_000)),
    ];
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it('rejects an entry that is off by a single pesewa', () => {
    const lines = [debit(CASH, m(50_000)), credit(SALES, m(49_999))];
    expect(() => assertBalanced(lines)).toThrow(UnbalancedEntryError);
  });

  it('reports the actual totals on the error', () => {
    try {
      assertBalanced([debit(CASH, m(100)), credit(SALES, m(90))]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnbalancedEntryError);
      const domainError = error as UnbalancedEntryError;
      expect(domainError.details['totalDebit']).toBe(100);
      expect(domainError.details['totalCredit']).toBe(90);
      expect(domainError.details['difference']).toBe(10);
      // The message shown to a shop owner must be reassuring and accurate.
      expect(domainError.userMessage).toContain('Nothing was changed');
    }
  });

  it('rejects empty, single-line and zero-value entries', () => {
    expect(() => assertBalanced([])).toThrow(ValidationError);
    expect(() => assertBalanced([debit(CASH, m(100))])).toThrow(ValidationError);
    expect(() => assertBalanced([debit(CASH, ZERO), credit(SALES, ZERO)])).toThrow(ValidationError);
  });

  it('rejects a line that is both a debit and a credit', () => {
    const malformed: DraftLine = { accountId: CASH, debit: m(100), credit: m(100) };
    expect(() => assertLinesWellFormed([malformed])).toThrow(ValidationError);
  });

  it('rejects an invalid account id', () => {
    const malformed: DraftLine = { accountId: 0, debit: m(100), credit: ZERO };
    expect(() => assertLinesWellFormed([malformed])).toThrow(ValidationError);
  });
});

describe('dropZeroLines / finaliseLines', () => {
  it('strips lines that move no money', () => {
    const lines = [
      debit(CASH, m(100)),
      debit(RECEIVABLE, ZERO), // e.g. a fully-paid sale has no receivable
      credit(SALES, m(100)),
    ];
    expect(dropZeroLines(lines)).toHaveLength(2);
    expect(finaliseLines(lines)).toHaveLength(2);
  });

  it('still enforces balance after stripping', () => {
    const lines = [debit(CASH, m(100)), credit(SALES, m(90)), credit(INVENTORY, ZERO)];
    expect(() => finaliseLines(lines)).toThrow(UnbalancedEntryError);
  });
});

describe('signedBalance', () => {
  it('presents debit-normal accounts positively', () => {
    // Cash: 500 in, 200 out -> 300
    expect(signedBalance('ASSET', m(50_000), m(20_000))).toBe(30_000);
    expect(signedBalance('EXPENSE', m(8_000), ZERO)).toBe(8_000);
    expect(signedBalance('COGS', m(32_000), ZERO)).toBe(32_000);
  });

  it('presents credit-normal accounts positively', () => {
    expect(signedBalance('LIABILITY', ZERO, m(60_000))).toBe(60_000);
    expect(signedBalance('REVENUE', ZERO, m(50_000))).toBe(50_000);
    expect(signedBalance('EQUITY', m(1_000), m(60_000))).toBe(59_000);
  });

  it('handles contra accounts as debit-normal', () => {
    // Owner drawings reduce equity but carry a positive debit balance.
    expect(signedBalance('CONTRA_EQUITY', m(20_000), ZERO)).toBe(20_000);
    expect(signedBalance('CONTRA_REVENUE', m(5_000), ZERO)).toBe(5_000);
  });

  it('can go negative when an account is genuinely overdrawn', () => {
    expect(signedBalance('ASSET', m(10_000), m(15_000))).toBe(-5_000);
  });
});

describe('reverseLines', () => {
  it('mirrors every line so the pair nets to zero', () => {
    const original = [debit(CASH, m(50_000)), credit(SALES, m(50_000))];
    const reversal = reverseLines(original);

    expect(reversal[0]).toMatchObject({ accountId: CASH, debit: 0, credit: 50_000 });
    expect(reversal[1]).toMatchObject({ accountId: SALES, debit: 50_000, credit: 0 });
    expect(() => assertBalanced(reversal)).not.toThrow();

    // Combined, the original and its reversal move nothing.
    const combined = [...original, ...reversal];
    expect(totalDebits(combined)).toBe(totalCredits(combined));
    expect(signedBalance('ASSET', totalDebits(combined), totalCredits(combined))).toBe(0);
  });

  it('preserves payment account linkage and labels the description', () => {
    const original = [
      debit(CASH, m(100), { paymentAccountId: 3, description: 'Cash sale' }),
      credit(SALES, m(100)),
    ];
    const reversal = reverseLines(original);
    expect(reversal[0]?.paymentAccountId).toBe(3);
    expect(reversal[0]?.description).toBe('Reversal: Cash sale');
    // A line with no description stays undefined rather than becoming "Reversal: undefined".
    expect(reversal[1]?.description).toBeUndefined();
  });

  it('round-trips a complex entry', () => {
    const original = [
      debit(CASH, m(20_000)),
      debit(RECEIVABLE, m(30_000)),
      credit(SALES, m(50_000)),
      debit(COGS, m(32_000)),
      credit(INVENTORY, m(32_000)),
    ];
    expect(() => assertBalanced(reverseLines(original))).not.toThrow();
    expect(reverseLines(reverseLines(original))).toEqual(
      original.map((l) => ({ ...l, ...(l.description ? {} : {}) })),
    );
  });
});

describe('chart of accounts', () => {
  it('assigns each account its correct normal balance', () => {
    for (const account of SYSTEM_ACCOUNTS) {
      expect(account.normalBalance, `${account.code} ${account.name}`).toBe(
        normalBalanceFor(account.type),
      );
      expect(normalBalanceOf(account.type)).toBe(account.normalBalance);
    }
  });

  it('has unique, stable account codes', () => {
    const codes = SYSTEM_ACCOUNTS.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('defines every code referenced by domain logic', () => {
    const defined = new Set(SYSTEM_ACCOUNTS.map((a) => a.code));
    for (const code of Object.values(ACCOUNT_CODES)) {
      expect(defined.has(code), `ACCOUNT_CODES references undefined account ${code}`).toBe(true);
    }
  });

  it('classifies balance sheet and P&L accounts exhaustively', () => {
    const allTypes: AccountType[] = [
      'ASSET',
      'LIABILITY',
      'EQUITY',
      'CONTRA_EQUITY',
      'REVENUE',
      'CONTRA_REVENUE',
      'COGS',
      'EXPENSE',
    ];
    for (const type of allTypes) {
      // Every type belongs to exactly one statement.
      expect(isBalanceSheetAccount(type)).toBe(!isProfitAndLossAccount(type));
    }
    expect(isBalanceSheetAccount('ASSET')).toBe(true);
    expect(isProfitAndLossAccount('REVENUE')).toBe(true);
    expect(isProfitAndLossAccount('COGS')).toBe(true);
  });
});
