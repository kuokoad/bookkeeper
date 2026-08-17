import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getSettings,
  hasPostedTransactions,
  updateSettings,
  type SettingsInput,
} from '@/services/settings.service';
import { listAuditLogs } from '@/services/audit.service';
import { createTestDatabase, accountIdFor, type TestDatabase } from '../helpers/test-db';
import { postJournalEntry } from '@/services/journal.service';
import { credit, debit } from '@/domain/accounting/journal';
import { minor } from '@/domain/money';
import { ACCOUNT_CODES } from '@/domain/accounting/chart-of-accounts';
import { createUser } from '@/services/auth.service';

let context: TestDatabase;
let ACTOR: { id: number; username: string };

beforeEach(async () => {
  context = createTestDatabase();
  const id = await createUser(
    context.db,
    { username: 'kwame', displayName: 'Kwame Owusu', password: 'owner-password-2026', role: 'OWNER' },
    null,
  );
  ACTOR = { id, username: 'kwame' };
});

afterEach(() => {
  context.cleanup();
});

/** The current settings, as an input object ready to be modified. */
function currentAsInput(): SettingsInput {
  const settings = getSettings(context.db);
  return {
    businessName: settings.businessName,
    address: settings.address,
    phone: settings.phone,
    email: settings.email,
    currencyCode: settings.currencyCode,
    currencySymbol: settings.currencySymbol,
    taxEnabled: settings.taxEnabled,
    taxRateBp: settings.taxRateBp,
    taxInclusive: settings.taxInclusive,
    taxLabel: settings.taxLabel,
    lowStockThresholdMilli: settings.lowStockThresholdMilli,
    allowNegativeStock: settings.allowNegativeStock,
  };
}

function postSomething(): void {
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

describe('the shop details', () => {
  it('saves what was entered', () => {
    updateSettings(
      context.db,
      { ...currentAsInput(), businessName: 'Adom Provisions', phone: '024 000 0000' },
      ACTOR,
    );

    const settings = getSettings(context.db);
    expect(settings.businessName).toBe('Adom Provisions');
    expect(settings.phone).toBe('024 000 0000');
  });

  it('stores a cleared field as nothing, not as an empty string', () => {
    updateSettings(context.db, { ...currentAsInput(), address: 'Madina Market' }, ACTOR);
    updateSettings(context.db, { ...currentAsInput(), address: null }, ACTOR);

    expect(getSettings(context.db).address).toBeNull();
  });
});

describe('changing the currency', () => {
  it('is allowed before any trading has happened', () => {
    expect(hasPostedTransactions(context.db)).toBe(false);

    updateSettings(
      context.db,
      { ...currentAsInput(), currencyCode: 'NGN', currencySymbol: '₦' },
      ACTOR,
    );

    const settings = getSettings(context.db);
    expect(settings.currencyCode).toBe('NGN');
    expect(settings.currencySymbol).toBe('₦');
  });

  it('is REFUSED once there are transactions', () => {
    postSomething();

    expect(() =>
      updateSettings(context.db, { ...currentAsInput(), currencyCode: 'USD' }, ACTOR),
    ).toThrow(/cannot be changed/i);

    // Nothing at all may have been written, not even the unrelated fields.
    expect(getSettings(context.db).currencyCode).toBe('GHS');
  });

  it('explains why, naming the currency the books are actually in', () => {
    postSomething();

    expect(() =>
      updateSettings(context.db, { ...currentAsInput(), currencyCode: 'USD' }, ACTOR),
    ).toThrow(/GHS/);
  });

  it('rolls back the WHOLE change, so nothing is half-saved', () => {
    postSomething();

    expect(() =>
      updateSettings(
        context.db,
        { ...currentAsInput(), businessName: 'Renamed Shop', currencyCode: 'USD' },
        ACTOR,
      ),
    ).toThrow();

    // The name change rode along with a refused currency change; it must not
    // have survived on its own.
    expect(getSettings(context.db).businessName).not.toBe('Renamed Shop');
  });

  it('still allows the SYMBOL to change after trading', () => {
    postSomething();

    updateSettings(context.db, { ...currentAsInput(), currencySymbol: 'GH₵' }, ACTOR);

    expect(getSettings(context.db).currencySymbol).toBe('GH₵');
    expect(getSettings(context.db).currencyCode).toBe('GHS');
  });

  it('saving without touching the currency is never blocked', () => {
    postSomething();
    expect(() =>
      updateSettings(context.db, { ...currentAsInput(), businessName: 'Still Fine' }, ACTOR),
    ).not.toThrow();
    expect(getSettings(context.db).businessName).toBe('Still Fine');
  });
});

describe('tax', () => {
  it('turns on with a rate held in basis points', () => {
    updateSettings(
      context.db,
      { ...currentAsInput(), taxEnabled: true, taxRateBp: 1250, taxLabel: 'VAT' },
      ACTOR,
    );

    const settings = getSettings(context.db);
    expect(settings.taxEnabled).toBe(true);
    expect(settings.taxRateBp).toBe(1250);
  });

  it('remembers the rate when tax is switched off', () => {
    updateSettings(context.db, { ...currentAsInput(), taxEnabled: true, taxRateBp: 1500 }, ACTOR);
    updateSettings(context.db, { ...currentAsInput(), taxEnabled: false }, ACTOR);

    // Switching it back on must not silently resume at zero.
    const settings = getSettings(context.db);
    expect(settings.taxEnabled).toBe(false);
    expect(settings.taxRateBp).toBe(1500);
  });
});

describe('the audit trail', () => {
  it('records what changed, from what to what', () => {
    updateSettings(context.db, { ...currentAsInput(), businessName: 'Adom Provisions' }, ACTOR);

    const entries = listAuditLogs(context.db, { action: 'SETTINGS_CHANGE' });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.summary).toContain('My Shop');
    expect(entries[0]?.summary).toContain('Adom Provisions');
    expect(entries[0]?.username).toBe('kwame');
  });

  it('spells out a policy change in words, not flags', () => {
    updateSettings(context.db, { ...currentAsInput(), allowNegativeStock: true }, ACTOR);

    const summary = listAuditLogs(context.db, { action: 'SETTINGS_CHANGE' })[0]?.summary ?? '';
    expect(summary).toMatch(/Allow negative stock: off → on/);
  });

  it('reports a tax rate as a percentage, the way it was entered', () => {
    updateSettings(context.db, { ...currentAsInput(), taxEnabled: true, taxRateBp: 1250 }, ACTOR);

    const summary = listAuditLogs(context.db, { action: 'SETTINGS_CHANGE' })[0]?.summary ?? '';
    expect(summary).toContain('12.5%');
  });

  it('writes NOTHING when a save changes nothing', () => {
    updateSettings(context.db, currentAsInput(), ACTOR);

    // A log full of "settings saved" entries that changed nothing is a log
    // nobody reads.
    expect(listAuditLogs(context.db, { action: 'SETTINGS_CHANGE' })).toHaveLength(0);
  });

  it('records nothing when the change was refused', () => {
    postSomething();
    expect(() =>
      updateSettings(context.db, { ...currentAsInput(), currencyCode: 'USD' }, ACTOR),
    ).toThrow();

    expect(listAuditLogs(context.db, { action: 'SETTINGS_CHANGE' })).toHaveLength(0);
  });
});
