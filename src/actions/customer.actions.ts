'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { db } from '@/db/client';
import { requirePermission } from '@/lib/auth/current-user';
import {
  createCustomer,
  setCustomerActive,
  updateCustomer,
} from '@/services/customer.service';
import { parseMoney, type Minor } from '@/domain/money';
import { isDomainError } from '@/domain/errors';
import type { FormState } from './auth.actions';

const customerSchema = z.object({
  name: z.string().trim().min(1, 'Enter the customer’s name.').max(120),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().max(120).optional(),
  address: z.string().trim().max(300).optional(),
  notes: z.string().trim().max(500).optional(),
  creditLimit: z.string().trim().optional(),
});

function readForm(formData: FormData) {
  return customerSchema.safeParse({
    name: formData.get('name'),
    phone: formData.get('phone') ?? undefined,
    email: formData.get('email') ?? undefined,
    address: formData.get('address') ?? undefined,
    notes: formData.get('notes') ?? undefined,
    creditLimit: formData.get('creditLimit') ?? undefined,
  });
}

function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  return fieldErrors;
}

/**
 * A blank credit limit means "no limit"; an explicit 0 means "no credit at
 * all". Those are genuinely different instructions, so the empty string is
 * never quietly turned into zero.
 */
function parseCreditLimit(raw: string | undefined): Minor | null {
  if (raw === undefined || raw.trim() === '') return null;
  return parseMoney(raw);
}

export async function createCustomerAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('customers', 'create');

  const parsed = readForm(formData);
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  let creditLimit: Minor | null;
  try {
    creditLimit = parseCreditLimit(parsed.data.creditLimit);
  } catch (error) {
    return {
      fieldErrors: {
        creditLimit: isDomainError(error) ? error.userMessage : 'Invalid amount.',
      },
    };
  }

  let customerId: number;
  try {
    customerId = createCustomer(
      db,
      { ...parsed.data, creditLimit },
      { id: actor.id, username: actor.username },
    );
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/customers');
  redirect(`/customers/${customerId}?created=1`);
}

export async function updateCustomerAction(
  customerId: number,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('customers', 'edit');

  const parsed = readForm(formData);
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  let creditLimit: Minor | null;
  try {
    creditLimit = parseCreditLimit(parsed.data.creditLimit);
  } catch (error) {
    return {
      fieldErrors: {
        creditLimit: isDomainError(error) ? error.userMessage : 'Invalid amount.',
      },
    };
  }

  try {
    updateCustomer(
      db,
      customerId,
      { ...parsed.data, creditLimit },
      { id: actor.id, username: actor.username },
    );
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/customers');
  revalidatePath(`/customers/${customerId}`);
  redirect(`/customers/${customerId}?updated=1`);
}

export async function setCustomerActiveAction(
  customerId: number,
  isActive: boolean,
): Promise<void> {
  const actor = await requirePermission('customers', 'edit');
  setCustomerActive(db, customerId, isActive, { id: actor.id, username: actor.username });
  revalidatePath('/customers');
  revalidatePath(`/customers/${customerId}`);
}
