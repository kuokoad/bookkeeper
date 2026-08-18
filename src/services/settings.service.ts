import { eq, sql } from 'drizzle-orm';

import { businessSettings, journalEntries } from '@/db/schema';
import type { Db, Tx } from '@/db/types';
import { NotFoundError, ValidationError } from '@/domain/errors';
import { writeAudit } from './audit.service';

/**
 * Reading and changing the shop's settings.
 *
 * These are not cosmetic preferences: the tax rate, the stock policy and the
 * currency all change how money is recorded. So each change is validated on the
 * server, written in one transaction, and recorded in the audit log with what
 * it was before and after.
 */

export interface Actor {
  id: number;
  username: string;
}

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export type BusinessSettings = typeof businessSettings.$inferSelect;

export function getSettings(db: Db): BusinessSettings {
  const settings = db.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
  if (!settings) throw new NotFoundError('Business settings', 1);
  return settings;
}

/** Whether anything has been posted to the books yet. */
export function hasPostedTransactions(db: Db | Tx): boolean {
  const row = db.select({ count: sql<number>`COUNT(*)` }).from(journalEntries).get();
  return (row?.count ?? 0) > 0;
}

export interface SettingsInput {
  businessName: string;
  address: string | null;
  phone: string | null;
  email: string | null;

  currencyCode: string;
  currencySymbol: string;

  taxEnabled: boolean;
  taxRateBp: number;
  taxInclusive: boolean;
  taxLabel: string;

  lowStockThresholdMilli: number;
  allowNegativeStock: boolean;
  allowOverpayment: boolean;

  /** Month the financial year starts, 1-12. Decides the year-end pack period. */
  financialYearStartMonth: number;
}

/** Reports a changed value the way a person would read it. */
function describeChange(label: string, before: unknown, after: unknown): string | null {
  if (before === after) return null;
  const show = (value: unknown) =>
    value === null || value === '' ? 'not set' : typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value);
  return `${label}: ${show(before)} → ${show(after)}`;
}

export interface LogoSummary {
  hasLogo: boolean;
  mime: string | null;
  width: number | null;
  height: number | null;
  bytes: number;
  updatedAt: Date | null;
}

/** What the settings screen needs to describe the logo, without the bytes. */
export function getLogoSummary(db: Db): LogoSummary {
  const settings = getSettings(db);
  return {
    hasLogo: settings.logoData !== null,
    mime: settings.logoMime,
    width: settings.logoWidth,
    height: settings.logoHeight,
    bytes: settings.logoData?.length ?? 0,
    updatedAt: settings.logoUpdatedAt,
  };
}

/** The image itself, for the route that serves it. */
export function getLogo(db: Db): { data: Buffer; mime: string; updatedAt: Date | null } | null {
  const settings = getSettings(db);
  if (!settings.logoData || !settings.logoMime) return null;
  return { data: settings.logoData, mime: settings.logoMime, updatedAt: settings.logoUpdatedAt };
}

/**
 * Stores a logo that has ALREADY been confirmed to be an image.
 *
 * The mime type recorded here is the one read from the file's own bytes by
 * `inspectImage`, never the one the browser announced — it is what the serving
 * route will send back, so trusting the upload would let someone choose the
 * Content-Type their file is served with.
 */
export function setLogo(
  db: Db,
  image: { data: Uint8Array; mime: string; width: number; height: number },
  actor: Actor,
): void {
  db.transaction((tx) => {
    const now = new Date();
    tx.update(businessSettings)
      .set({
        logoData: Buffer.from(image.data),
        logoMime: image.mime,
        logoWidth: image.width,
        logoHeight: image.height,
        logoUpdatedAt: now,
        updatedAt: now,
      })
      .where(eq(businessSettings.id, 1))
      .run();

    writeAudit(tx, {
      action: 'SETTINGS_CHANGE',
      entityType: 'business_settings',
      entityId: 1,
      userId: actor.id,
      username: actor.username,
      summary: `Logo updated (${image.mime}, ${image.width}x${image.height}, ${image.data.length} bytes)`,
      at: now,
    });
  });
}

export function clearLogo(db: Db, actor: Actor): void {
  db.transaction((tx) => {
    const existing = tx.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
    if (!existing?.logoData) return;

    const now = new Date();
    tx.update(businessSettings)
      .set({
        logoData: null,
        logoMime: null,
        logoWidth: null,
        logoHeight: null,
        logoUpdatedAt: null,
        updatedAt: now,
      })
      .where(eq(businessSettings.id, 1))
      .run();

    writeAudit(tx, {
      action: 'SETTINGS_CHANGE',
      entityType: 'business_settings',
      entityId: 1,
      userId: actor.id,
      username: actor.username,
      summary: 'Logo removed',
      at: now,
    });
  });
}

export function updateSettings(db: Db, input: SettingsInput, actor: Actor): void {
  db.transaction((tx) => {
    const before = tx.select().from(businessSettings).where(eq(businessSettings.id, 1)).get();
    if (!before) throw new NotFoundError('Business settings', 1);

    // --- the guard that matters -------------------------------------------
    //
    // No amount stores its own currency: every figure in the books is a count
    // of minor units, and the code here is what labels all of them. Changing it
    // once trading has started would silently relabel every historical amount —
    // a GHS 5,000 sale from last month would begin reading as USD 5,000 without
    // a single row being touched. That is precisely the "silently modifying
    // history" this application refuses to do, so it is refused outright.
    //
    // The symbol is a different matter: ₵ and GH₵ are two ways of writing the
    // same currency, so that stays editable.
    if (input.currencyCode !== before.currencyCode && hasPostedTransactions(tx)) {
      throw new ValidationError(
        `The currency cannot be changed from ${before.currencyCode} once there are transactions — ` +
          'every amount already recorded is in that currency, and relabelling them would misstate ' +
          'your history. Start a new set of books to trade in a different currency.',
        { from: before.currencyCode, to: input.currencyCode },
      );
    }

    const now = new Date();
    tx.update(businessSettings)
      .set({
        businessName: input.businessName,
        address: input.address,
        phone: input.phone,
        email: input.email,
        currencyCode: input.currencyCode,
        currencySymbol: input.currencySymbol,
        taxEnabled: input.taxEnabled,
        // Keep the rate that was set even when tax is switched off, so switching
        // it back on does not silently resume at zero.
        taxRateBp: input.taxRateBp,
        taxInclusive: input.taxInclusive,
        taxLabel: input.taxLabel,
        lowStockThresholdMilli: input.lowStockThresholdMilli,
        allowNegativeStock: input.allowNegativeStock,
        allowOverpayment: input.allowOverpayment,
        financialYearStartMonth: input.financialYearStartMonth,
        updatedAt: now,
      })
      .where(eq(businessSettings.id, 1))
      .run();

    // Record what actually changed, not merely that "settings were saved".
    // Switching tax on or letting stock go negative changes how money is
    // recorded, and an auditor should be able to see when that happened.
    const changes = [
      describeChange('Shop name', before.businessName, input.businessName),
      describeChange('Address', before.address, input.address),
      describeChange('Phone', before.phone, input.phone),
      describeChange('Email', before.email, input.email),
      describeChange('Currency', before.currencyCode, input.currencyCode),
      describeChange('Currency symbol', before.currencySymbol, input.currencySymbol),
      describeChange('Tax', before.taxEnabled, input.taxEnabled),
      describeChange('Tax rate', `${before.taxRateBp / 100}%`, `${input.taxRateBp / 100}%`),
      describeChange('Prices include tax', before.taxInclusive, input.taxInclusive),
      describeChange('Tax name', before.taxLabel, input.taxLabel),
      describeChange(
        'Low stock level',
        before.lowStockThresholdMilli / 1000,
        input.lowStockThresholdMilli / 1000,
      ),
      describeChange('Allow negative stock', before.allowNegativeStock, input.allowNegativeStock),
      describeChange(
        'Allow paying more than is owed',
        before.allowOverpayment,
        input.allowOverpayment,
      ),
      describeChange(
        'Financial year starts',
        MONTH_NAMES[before.financialYearStartMonth - 1],
        MONTH_NAMES[input.financialYearStartMonth - 1],
      ),
    ].filter((change): change is string => change !== null);

    if (changes.length === 0) return;

    writeAudit(tx, {
      action: 'SETTINGS_CHANGE',
      entityType: 'business_settings',
      entityId: 1,
      userId: actor.id,
      username: actor.username,
      summary: changes.join('; '),
      at: now,
    });
  });
}
