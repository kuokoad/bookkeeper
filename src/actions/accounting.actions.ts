'use server';

import { revalidatePath } from 'next/cache';

import { db } from '@/db/client';
import { requirePermission } from '@/lib/auth/current-user';
import { setBooksLock } from '@/services/period-lock.service';
import { isDomainError } from '@/domain/errors';
import { isValidBusinessDate } from '@/lib/format';
import type { FormState } from './auth.actions';

/**
 * Closing and reopening the books.
 *
 * Requires the `settings` permission, which staff do not have by default — this
 * is an owner-level control, and granting it to a till operator would defeat
 * the point of having a lock at all.
 */
export async function setBooksLockAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('settings', 'edit');

  const raw = String(formData.get('lockedBefore') ?? '').trim();
  const lockedBefore = raw === '' ? null : raw;

  if (lockedBefore !== null && !isValidBusinessDate(lockedBefore)) {
    return { fieldErrors: { lockedBefore: 'Enter a valid date.' } };
  }

  try {
    setBooksLock(db, lockedBefore, { id: actor.id, username: actor.username });
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/accounting');
  revalidatePath('/dashboard');
  return {};
}
