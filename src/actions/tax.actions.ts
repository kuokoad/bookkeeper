'use server';

import { revalidatePath } from 'next/cache';

import { db } from '@/db/client';
import { requirePermission } from '@/lib/auth/current-user';
import {
  createTaxComponent,
  setTaxComponentActive,
  updateTaxComponent,
  type TaxComponentInput,
} from '@/services/tax.service';
import { TAX_BASES, type TaxBasis } from '@/db/schema';
import { parsePercentToBasisPoints } from '@/domain/rate';
import { isDomainError } from '@/domain/errors';
import type { FormState } from './auth.actions';

/**
 * Editing what the shop charges.
 *
 * Behind the same `settings` permission as the rest of the shop's policy: a
 * till operator who could add a tax could change every price in the shop.
 */

function refresh(): void {
  revalidatePath('/settings');
  // The till prices from these, so it must not keep showing yesterday's rate.
  revalidatePath('/sales/new');
}

/** Turn a form into service input, reporting against the field that is wrong. */
function readForm(
  formData: FormData,
): { ok: true; value: TaxComponentInput } | { ok: false; state: FormState } {
  const basis = String(formData.get('basis') ?? 'NET');
  if (!TAX_BASES.includes(basis as TaxBasis)) {
    return { ok: false, state: { fieldErrors: { basis: 'Choose what the tax is charged on.' } } };
  }

  // The person types a percentage; the books hold basis points. One conversion,
  // from the domain, so the form and the ledger cannot disagree about "12.5".
  let rateBp: number;
  try {
    rateBp = parsePercentToBasisPoints(String(formData.get('rate') ?? ''));
  } catch (error) {
    if (!isDomainError(error)) throw error;
    return { ok: false, state: { fieldErrors: { rate: error.userMessage } } };
  }

  const glAccountId = Number(formData.get('glAccountId'));
  if (!Number.isInteger(glAccountId) || glAccountId <= 0) {
    return {
      ok: false,
      state: { fieldErrors: { glAccountId: 'Choose the account this tax is held in.' } },
    };
  }

  const sortOrder = Number(formData.get('sortOrder') ?? 0);

  return {
    ok: true,
    value: {
      code: String(formData.get('code') ?? ''),
      name: String(formData.get('name') ?? ''),
      rateBp,
      basis: basis as TaxBasis,
      isRecoverable: formData.get('isRecoverable') === 'on',
      glAccountId,
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
      isActive: formData.get('isActive') !== 'off',
    },
  };
}

function asFormState(error: unknown): FormState {
  if (isDomainError(error)) return { error: error.userMessage };
  throw error;
}

export async function createTaxComponentAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('settings', 'edit');

  const parsed = readForm(formData);
  if (!parsed.ok) return parsed.state;

  try {
    createTaxComponent(db, parsed.value, { id: actor.id, username: actor.username });
  } catch (error) {
    return asFormState(error);
  }

  refresh();
  return { success: `${parsed.value.name.trim()} added.` };
}

export async function updateTaxComponentAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('settings', 'edit');

  const id = Number(formData.get('id'));
  if (!Number.isInteger(id) || id <= 0) return { error: 'That tax could not be found.' };

  const parsed = readForm(formData);
  if (!parsed.ok) return parsed.state;

  try {
    updateTaxComponent(db, id, parsed.value, { id: actor.id, username: actor.username });
  } catch (error) {
    return asFormState(error);
  }

  refresh();
  return { success: `${parsed.value.name.trim()} saved.` };
}

export async function setTaxComponentActiveAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('settings', 'edit');

  const id = Number(formData.get('id'));
  if (!Number.isInteger(id) || id <= 0) return { error: 'That tax could not be found.' };

  const isActive = formData.get('isActive') === 'on';

  try {
    setTaxComponentActive(db, id, isActive, { id: actor.id, username: actor.username });
  } catch (error) {
    return asFormState(error);
  }

  refresh();
  return { success: isActive ? 'Tax switched on.' : 'Tax switched off.' };
}
