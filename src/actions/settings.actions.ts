'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { db } from '@/db/client';
import { requirePermission } from '@/lib/auth/current-user';
import { clearLogo, setLogo, updateSettings } from '@/services/settings.service';
import { MAX_IMAGE_BYTES, inspectImage } from '@/lib/image';
import { parsePercentToBasisPoints } from '@/domain/rate';
import { parseQty } from '@/domain/quantity';
import { isDomainError } from '@/domain/errors';
import type { FormState } from './auth.actions';

/**
 * Changing the shop's settings.
 *
 * Requires the `settings` permission, which staff do not have by default. These
 * control how money is recorded — a till operator should not be able to switch
 * tax off or let stock go negative.
 */

/** Blank strings from an untouched optional input mean "not set", not "". */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable();

const settingsSchema = z.object({
  businessName: z.string().trim().min(2, 'Enter your shop name.').max(120),
  tagline: optionalText(60),
  address: optionalText(240),
  phone: optionalText(40),
  email: z
    .string()
    .trim()
    .max(160)
    .refine((value) => value === '' || z.email().safeParse(value).success, {
      message: 'Enter a valid email address, or leave it blank.',
    })
    .transform((value) => (value === '' ? null : value))
    .nullable(),

  currencyCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Use the three-letter code, like GHS or NGN.'),
  currencySymbol: z.string().trim().min(1, 'Enter the symbol shown on receipts.').max(8),

  taxEnabled: z.boolean(),
  // Held in basis points so the rate stays an integer: 12.5% is 1250, never 0.125.
  taxRateBp: z
    .number()
    .int('Enter the rate as a percentage, up to two decimal places.')
    .min(0, 'A tax rate cannot be negative.')
    .max(10_000, 'A tax rate above 100% is not a tax rate.'),
  taxInclusive: z.boolean(),
  taxLabel: z.string().trim().min(1, 'Give the tax a name, like VAT.').max(20),

  lowStockThresholdMilli: z
    .number()
    .int()
    .min(0, 'A low stock level cannot be negative.')
    .max(1_000_000_000),
  allowNegativeStock: z.boolean(),
  allowOverpayment: z.boolean(),

  financialYearStartMonth: z
    .number()
    .int()
    .min(1, 'Choose the month your financial year starts.')
    .max(12, 'Choose the month your financial year starts.'),
});

const checkbox = (formData: FormData, name: string): boolean => formData.get(name) === 'on';

/**
 * Both conversions come from the domain layer rather than being written again
 * here. A second implementation of "what does 12.5 mean" is how the form and
 * the ledger end up disagreeing.
 */
function parseOrFieldError<T>(
  parse: () => T,
): { ok: true; value: T } | { ok: false; message: string } {
  try {
    return { ok: true, value: parse() };
  } catch (error) {
    if (isDomainError(error)) return { ok: false, message: error.userMessage };
    throw error;
  }
}

export async function updateSettingsAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('settings', 'edit');

  // Parsed here rather than in the schema so a malformed number reports against
  // the field the person typed into, not as a type error.
  const rate = parseOrFieldError(() =>
    parsePercentToBasisPoints(String(formData.get('taxRate') ?? '0')),
  );
  if (!rate.ok) return { fieldErrors: { taxRate: rate.message } };

  const lowStock = parseOrFieldError(() => parseQty(String(formData.get('lowStock') ?? '0')));
  if (!lowStock.ok) return { fieldErrors: { lowStock: lowStock.message } };
  if (lowStock.value < 0) {
    return { fieldErrors: { lowStock: 'A low stock level cannot be negative.' } };
  }

  const taxRateBp = rate.value;
  const lowStockThresholdMilli = lowStock.value as number;

  const parsed = settingsSchema.safeParse({
    businessName: formData.get('businessName'),
    tagline: formData.get('tagline'),
    address: formData.get('address'),
    phone: formData.get('phone'),
    email: formData.get('email'),
    currencyCode: formData.get('currencyCode'),
    currencySymbol: formData.get('currencySymbol'),
    taxEnabled: checkbox(formData, 'taxEnabled'),
    taxRateBp,
    taxInclusive: checkbox(formData, 'taxInclusive'),
    taxLabel: formData.get('taxLabel'),
    lowStockThresholdMilli,
    allowNegativeStock: checkbox(formData, 'allowNegativeStock'),
    allowOverpayment: checkbox(formData, 'allowOverpayment'),
    financialYearStartMonth: Number(formData.get('financialYearStartMonth') ?? 1),
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { fieldErrors };
  }

  try {
    updateSettings(db, parsed.data, { id: actor.id, username: actor.username });
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  // The shop name, currency and tax appear on nearly every screen.
  revalidatePath('/', 'layout');
  return { success: 'Settings saved.' };
}

/**
 * Uploading the shop's logo.
 *
 * The file is confirmed to be an image from its own bytes before anything is
 * stored — the browser's declared type and the filename are never consulted,
 * and the filename never touches a path. See `src/lib/image.ts` for why SVG is
 * refused.
 */
export async function uploadLogoAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('settings', 'edit');

  const file = formData.get('logo');
  if (!(file instanceof File) || file.size === 0) {
    return { fieldErrors: { logo: 'Choose an image to upload.' } };
  }

  // Checked before reading the whole thing into memory, so an oversized upload
  // is refused rather than buffered.
  if (file.size > MAX_IMAGE_BYTES) {
    return {
      fieldErrors: {
        logo: `That image is ${(file.size / 1_000_000).toFixed(1)} MB. Please use one under ${MAX_IMAGE_BYTES / 1_000_000} MB.`,
      },
    };
  }

  const data = new Uint8Array(await file.arrayBuffer());

  try {
    const image = inspectImage(data);
    setLogo(
      db,
      { data, mime: image.mime, width: image.width, height: image.height },
      { id: actor.id, username: actor.username },
    );
  } catch (error) {
    if (isDomainError(error)) return { fieldErrors: { logo: error.userMessage } };
    throw error;
  }

  revalidatePath('/', 'layout');
  return { success: 'Logo updated. It will appear on your receipts.' };
}

export async function removeLogoAction(): Promise<void> {
  const actor = await requirePermission('settings', 'edit');
  clearLogo(db, { id: actor.id, username: actor.username });
  revalidatePath('/', 'layout');
}
