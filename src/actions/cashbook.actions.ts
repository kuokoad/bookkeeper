'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { db } from '@/db/client';
import { requirePermission } from '@/lib/auth/current-user';
import {
  recordExpense,
  recordIncome,
  recordOwnerCapital,
  recordOwnerDrawings,
  voidExpense,
  voidIncome,
} from '@/services/cashbook.service';
import {
  createCategory,
  createPaymentAccount,
  setPaymentAccountActive,
  updatePaymentAccount,
} from '@/services/payment-account.service';
import { PAYMENT_ACCOUNT_KINDS } from '@/db/schema/accounting';
import { parseMoney, type Minor } from '@/domain/money';
import { isDomainError } from '@/domain/errors';
import { isValidBusinessDate } from '@/lib/format';
import type { FormState } from './auth.actions';

/** Expenses, other income, categories and payment accounts. */

function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  return fieldErrors;
}

const cashbookSchema = z.object({
  businessDate: z.string().refine(isValidBusinessDate, 'Enter a valid date.'),
  categoryAccountId: z.coerce.number().int().positive('Choose a category.'),
  description: z.string().trim().min(1, 'Enter a short description.').max(200),
  amount: z.string().trim().min(1, 'Enter an amount.'),
  paymentAccountId: z.coerce.number().int().positive('Choose an account.'),
  reference: z.string().trim().max(80).optional(),
  note: z.string().trim().max(300).optional(),
});

function readCashbookForm(formData: FormData) {
  return cashbookSchema.safeParse({
    businessDate: formData.get('businessDate'),
    categoryAccountId: formData.get('categoryAccountId'),
    description: formData.get('description'),
    amount: formData.get('amount'),
    paymentAccountId: formData.get('paymentAccountId'),
    reference: formData.get('reference') ?? undefined,
    note: formData.get('note') ?? undefined,
  });
}

export async function recordExpenseAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('expenses', 'create');

  const parsed = readCashbookForm(formData);
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  let amount: Minor;
  try {
    amount = parseMoney(parsed.data.amount);
  } catch (error) {
    return {
      fieldErrors: { amount: isDomainError(error) ? error.userMessage : 'Invalid amount.' },
    };
  }

  try {
    recordExpense(db, { ...parsed.data, amount }, { id: actor.id, username: actor.username });
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/expenses');
  revalidatePath('/accounts');
  revalidatePath('/dashboard');
  redirect('/expenses?created=1');
}

export async function recordIncomeAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('income', 'create');

  const parsed = readCashbookForm(formData);
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  let amount: Minor;
  try {
    amount = parseMoney(parsed.data.amount);
  } catch (error) {
    return {
      fieldErrors: { amount: isDomainError(error) ? error.userMessage : 'Invalid amount.' },
    };
  }

  try {
    recordIncome(db, { ...parsed.data, amount }, { id: actor.id, username: actor.username });
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/income');
  revalidatePath('/accounts');
  revalidatePath('/dashboard');
  redirect('/income?created=1');
}

export async function voidExpenseAction(
  id: number,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('expenses', 'void');
  const reason = String(formData.get('reason') ?? '').trim();
  if (reason.length < 3) return { fieldErrors: { reason: 'Give a reason for voiding this.' } };

  try {
    voidExpense(db, id, reason, { id: actor.id, username: actor.username });
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/expenses');
  revalidatePath('/accounts');
  revalidatePath('/dashboard');
  redirect('/expenses?voided=1');
}

export async function voidIncomeAction(
  id: number,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('income', 'void');
  const reason = String(formData.get('reason') ?? '').trim();
  if (reason.length < 3) return { fieldErrors: { reason: 'Give a reason for voiding this.' } };

  try {
    voidIncome(db, id, reason, { id: actor.id, username: actor.username });
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/income');
  revalidatePath('/accounts');
  revalidatePath('/dashboard');
  redirect('/income?voided=1');
}

// --- categories -----------------------------------------------------------

export async function createExpenseCategoryAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('expenses', 'create');
  const name = String(formData.get('name') ?? '').trim();
  if (name.length === 0) return { fieldErrors: { name: 'Enter a category name.' } };

  try {
    createCategory(db, 'EXPENSE', name, { id: actor.id, username: actor.username });
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/expenses');
  return {};
}

export async function createIncomeCategoryAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('income', 'create');
  const name = String(formData.get('name') ?? '').trim();
  if (name.length === 0) return { fieldErrors: { name: 'Enter a category name.' } };

  try {
    createCategory(db, 'INCOME', name, { id: actor.id, username: actor.username });
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/income');
  return {};
}

// --- owner capital and drawings -------------------------------------------

const ownerMovementSchema = z.object({
  businessDate: z.string().refine(isValidBusinessDate, 'Enter a valid date.'),
  paymentAccountId: z.coerce.number().int().positive('Choose an account.'),
  amount: z.string().trim().min(1, 'Enter an amount.'),
  description: z.string().trim().max(200).optional(),
});

async function handleOwnerMovement(
  direction: 'CAPITAL' | 'DRAWINGS',
  formData: FormData,
): Promise<FormState> {
  // Money moving between the owner and the business is an owner-level action.
  const actor = await requirePermission('accounts', 'create');

  const parsed = ownerMovementSchema.safeParse({
    businessDate: formData.get('businessDate'),
    paymentAccountId: formData.get('paymentAccountId'),
    amount: formData.get('amount'),
    description: formData.get('description') ?? undefined,
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  let amount: Minor;
  try {
    amount = parseMoney(parsed.data.amount);
  } catch (error) {
    return {
      fieldErrors: { amount: isDomainError(error) ? error.userMessage : 'Invalid amount.' },
    };
  }

  const input = { ...parsed.data, amount };
  const actorRef = { id: actor.id, username: actor.username };

  try {
    if (direction === 'CAPITAL') recordOwnerCapital(db, input, actorRef);
    else recordOwnerDrawings(db, input, actorRef);
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/accounts');
  revalidatePath('/accounting');
  revalidatePath('/dashboard');
  return {};
}

export async function recordOwnerCapitalAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return handleOwnerMovement('CAPITAL', formData);
}

export async function recordOwnerDrawingsAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return handleOwnerMovement('DRAWINGS', formData);
}

// --- payment accounts -----------------------------------------------------

const paymentAccountSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(80),
  kind: z.enum(PAYMENT_ACCOUNT_KINDS),
  provider: z.string().trim().max(60).optional(),
  accountNumber: z.string().trim().max(60).optional(),
  isDefault: z.string().optional(),
});

export async function createPaymentAccountAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('accounts', 'create');

  const parsed = paymentAccountSchema.safeParse({
    name: formData.get('name'),
    kind: formData.get('kind'),
    provider: formData.get('provider') ?? undefined,
    accountNumber: formData.get('accountNumber') ?? undefined,
    isDefault: formData.get('isDefault') ?? undefined,
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  try {
    createPaymentAccount(
      db,
      {
        name: parsed.data.name,
        kind: parsed.data.kind,
        provider: parsed.data.provider,
        accountNumber: parsed.data.accountNumber,
        isDefault: parsed.data.isDefault === 'on',
      },
      { id: actor.id, username: actor.username },
    );
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/accounts');
  revalidatePath('/dashboard');
  return {};
}

export async function updatePaymentAccountAction(
  accountId: number,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('accounts', 'edit');

  const parsed = paymentAccountSchema.safeParse({
    name: formData.get('name'),
    kind: formData.get('kind'),
    provider: formData.get('provider') ?? undefined,
    accountNumber: formData.get('accountNumber') ?? undefined,
    isDefault: formData.get('isDefault') ?? undefined,
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  try {
    updatePaymentAccount(
      db,
      accountId,
      {
        name: parsed.data.name,
        kind: parsed.data.kind,
        provider: parsed.data.provider,
        accountNumber: parsed.data.accountNumber,
        isDefault: parsed.data.isDefault === 'on',
      },
      { id: actor.id, username: actor.username },
    );
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/accounts');
  revalidatePath(`/accounts/${accountId}`);
  redirect(`/accounts/${accountId}?updated=1`);
}

export async function setPaymentAccountActiveAction(
  accountId: number,
  isActive: boolean,
): Promise<void> {
  const actor = await requirePermission('accounts', 'edit');
  setPaymentAccountActive(db, accountId, isActive, { id: actor.id, username: actor.username });
  revalidatePath('/accounts');
}
