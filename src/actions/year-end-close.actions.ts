'use server';

import { revalidatePath } from 'next/cache';

import { db } from '@/db/client';
import { requirePermission } from '@/lib/auth/current-user';
import { closeFinancialYear, reopenFinancialYear } from '@/services/year-end-close.service';
import { isDomainError } from '@/domain/errors';
import { money } from '@/lib/format';
import type { FormState } from './auth.actions';

/**
 * Closing and reopening a financial year.
 *
 * Owner-level: closing declares a year's figures final and locks it, and
 * reopening undoes that. Neither is something a till operator should reach.
 */

function readYear(formData: FormData): number | null {
  const raw = Number(formData.get('startYear'));
  return Number.isInteger(raw) && raw > 1900 && raw < 9999 ? raw : null;
}

export async function closeYearAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('settings', 'edit');

  const startYear = readYear(formData);
  if (startYear === null) return { error: 'Choose a year to close.' };

  try {
    const result = closeFinancialYear(db, startYear, { id: actor.id, username: actor.username });
    revalidatePath('/', 'layout');
    return {
      success:
        `Year closed. Profit of ${money(result.profit)} carried to Retained Earnings` +
        `${result.drawings > 0 ? `, after drawings of ${money(result.drawings)}` : ''}. ` +
        'The books are now locked to the year end.',
    };
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }
}

export async function reopenYearAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('settings', 'edit');

  const startYear = readYear(formData);
  if (startYear === null) return { error: 'Choose a year to reopen.' };

  try {
    reopenFinancialYear(db, startYear, { id: actor.id, username: actor.username });
    revalidatePath('/', 'layout');
    return {
      success:
        'Year reopened. The closing entry was reversed rather than deleted, and the books lock ' +
        'has moved back. Close it again when you are done.',
    };
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }
}
