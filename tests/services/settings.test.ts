import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearLogo,
  getLogo,
  getLogoSummary,
  setLogo,
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
    tagline: settings.tagline,
    address: settings.address,
    phone: settings.phone,
    email: settings.email,
    currencyCode: settings.currencyCode,
    currencySymbol: settings.currencySymbol,
    look: settings.look,
    taxEnabled: settings.taxEnabled,
    taxInclusive: settings.taxInclusive,
    lowStockThresholdMilli: settings.lowStockThresholdMilli,
    allowNegativeStock: settings.allowNegativeStock,
    expiryWarningDays: settings.expiryWarningDays,
    expiryBlocksSales: settings.expiryBlocksSales,
    allowOverpayment: settings.allowOverpayment,
    defaultTermsDays: settings.defaultTermsDays,
    financialYearStartMonth: settings.financialYearStartMonth,
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

  it('updates the tagline shown under the shop name', () => {
    updateSettings(context.db, { ...currentAsInput(), tagline: 'Provisions since 2016' }, ACTOR);
    expect(getSettings(context.db).tagline).toBe('Provisions since 2016');
  });

  it('lets the tagline be removed entirely', () => {
    // Cleared means gone, not reverted to the wording it shipped with.
    updateSettings(context.db, { ...currentAsInput(), tagline: null }, ACTOR);
    expect(getSettings(context.db).tagline).toBeNull();
  });

  it('records a tagline change in the audit log', () => {
    updateSettings(context.db, { ...currentAsInput(), tagline: 'Provisions since 2016' }, ACTOR);
    const summary = listAuditLogs(context.db, { action: 'SETTINGS_CHANGE' })[0]?.summary ?? '';
    expect(summary).toMatch(/Tagline: .* → Provisions since 2016/);
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
  /**
   * Settings owns WHETHER the shop charges tax and whether its prices already
   * include it. What it charges is the component list, which is edited on its
   * own and covered by tax-components-crud.test.ts. This form must not be able
   * to write a rate at all — two places to set one number is how a shop ends
   * up charging something nobody chose.
   */
  it('switches tax on and off without touching what is charged', () => {
    const before = getSettings(context.db).taxRateBp;

    updateSettings(context.db, { ...currentAsInput(), taxEnabled: true }, ACTOR);
    expect(getSettings(context.db).taxRateBp).toBe(before);

    updateSettings(context.db, { ...currentAsInput(), taxEnabled: false }, ACTOR);

    // Switching it back on must not silently resume at zero.
    const settings = getSettings(context.db);
    expect(settings.taxEnabled).toBe(false);
    expect(settings.taxRateBp).toBe(before);
  });

  it('records whether prices include tax, which changes what a price means', () => {
    updateSettings(context.db, { ...currentAsInput(), taxInclusive: true }, ACTOR);
    expect(getSettings(context.db).taxInclusive).toBe(true);
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

  it('names the month when the financial year changes', () => {
    updateSettings(context.db, { ...currentAsInput(), financialYearStartMonth: 4 }, ACTOR);

    const summary = listAuditLogs(context.db, { action: 'SETTINGS_CHANGE' })[0]?.summary ?? '';
    // "1 → 4" would mean nothing to whoever reads this later.
    expect(summary).toMatch(/Financial year starts: January → April/);
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

describe('the shop logo', () => {
  // A real 1x1 PNG. The service stores whatever it is given; the bytes are
  // confirmed to be an image before it gets here (see tests/lib/image.test.ts).
  const PNG = new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );

  it('stores the image and reports what it is', () => {
    setLogo(context.db, { data: PNG, mime: 'image/png', width: 1, height: 1 }, ACTOR);

    const summary = getLogoSummary(context.db);
    expect(summary.hasLogo).toBe(true);
    expect(summary.mime).toBe('image/png');
    expect(summary.bytes).toBe(PNG.length);
    expect(summary.updatedAt).toBeInstanceOf(Date);
  });

  it('gives back exactly the bytes it was given', () => {
    setLogo(context.db, { data: PNG, mime: 'image/png', width: 1, height: 1 }, ACTOR);

    const logo = getLogo(context.db);
    // A logo that came back altered would print as a broken image on receipts.
    expect(logo?.mime).toBe('image/png');
    expect(new Uint8Array(logo!.data)).toEqual(PNG);
  });

  it('lives in the database, so a backup carries it', () => {
    setLogo(context.db, { data: PNG, mime: 'image/png', width: 1, height: 1 }, ACTOR);

    // Read through a separate connection to the same file: proof it is in the
    // database rather than held in memory or written beside it.
    const row = context.connection
      .prepare('SELECT logo_data, logo_mime FROM business_settings WHERE id = 1')
      .get() as { logo_data: Buffer; logo_mime: string };

    expect(row.logo_mime).toBe('image/png');
    expect(new Uint8Array(row.logo_data)).toEqual(PNG);
  });

  it('reports no logo before one is set', () => {
    expect(getLogoSummary(context.db).hasLogo).toBe(false);
    expect(getLogo(context.db)).toBeNull();
  });

  it('removes it, leaving nothing behind', () => {
    setLogo(context.db, { data: PNG, mime: 'image/png', width: 1, height: 1 }, ACTOR);
    clearLogo(context.db, ACTOR);

    expect(getLogo(context.db)).toBeNull();
    const summary = getLogoSummary(context.db);
    expect(summary.hasLogo).toBe(false);
    expect(summary.mime).toBeNull();
    expect(summary.bytes).toBe(0);
  });

  it('records both setting and removing in the audit log', () => {
    setLogo(context.db, { data: PNG, mime: 'image/png', width: 1, height: 1 }, ACTOR);
    clearLogo(context.db, ACTOR);

    const summaries = listAuditLogs(context.db, { action: 'SETTINGS_CHANGE' }).map((e) => e.summary);
    expect(summaries.some((s) => /Logo removed/.test(s))).toBe(true);
    expect(summaries.some((s) => /Logo updated .*image\/png/.test(s))).toBe(true);
  });

  it('writes nothing when removing a logo that was never there', () => {
    clearLogo(context.db, ACTOR);
    expect(listAuditLogs(context.db, { action: 'SETTINGS_CHANGE' })).toHaveLength(0);
  });

  it('replacing one keeps only the newest', () => {
    const other = new Uint8Array([...PNG, 0, 0, 0]);
    setLogo(context.db, { data: PNG, mime: 'image/png', width: 1, height: 1 }, ACTOR);
    setLogo(context.db, { data: other, mime: 'image/webp', width: 2, height: 2 }, ACTOR);

    const summary = getLogoSummary(context.db);
    expect(summary.mime).toBe('image/webp');
    expect(summary.bytes).toBe(other.length);
  });
});

describe('the expiry settings', () => {
  /**
   * These two decide whether a till refuses a sale, so they had to become
   * editable by the shop rather than by whoever can open the database. They
   * existed as columns for several commits with no way to change them, which
   * meant a shop selling bread was stuck with a thirty-day warning and no way
   * to turn the block off.
   */
  it('round-trip through the form input', () => {
    updateSettings(
      context.db,
      { ...currentAsInput(), expiryWarningDays: 7, expiryBlocksSales: false },
      ACTOR,
    );

    const settings = getSettings(context.db);
    expect(settings.expiryWarningDays).toBe(7);
    expect(settings.expiryBlocksSales).toBe(false);
  });

  it('refuses a warning period that is not a period', () => {
    expect(() =>
      updateSettings(context.db, { ...currentAsInput(), expiryWarningDays: -1 }, ACTOR),
    ).toThrow();
  });

  it('leaves the other stock settings alone', () => {
    const before = getSettings(context.db);
    updateSettings(context.db, { ...currentAsInput(), expiryWarningDays: 3 }, ACTOR);

    const after = getSettings(context.db);
    expect(after.lowStockThresholdMilli).toBe(before.lowStockThresholdMilli);
    expect(after.allowNegativeStock).toBe(before.allowNegativeStock);
  });
});
