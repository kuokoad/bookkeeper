'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { db } from '@/db/client';
import { requirePermission } from '@/lib/auth/current-user';
import {
  createReconciliation,
  voidReconciliation,
} from '@/services/reconciliation.service';
import { parseMoney, type Minor } from '@/domain/money';
import { isDomainError } from '@/domain/errors';
import { isValidBusinessDate } from '@/lib/format';
import type { FormState } from './auth.actions';

/**
 * Counting cash, MoMo and bank balances.
 *
 * Requires the `reconciliation` permission, which staff do not hold by default:
 * someone who can both take money and sign off the count has no oversight at
 * all, which is the exact situation this feature exists to prevent.
 */

export interface ReconcileFormState extends FormState {
  reconciliationNo?: string;
  differenceMinor?: number;
  adjusted?: boolean;
}

const schema = z.object({
  paymentAccountId: z.coerce.number().int().positive('Choose an account.'),
  businessDate: z.string().refine(isValidBusinessDate, 'Enter a valid date.'),
  actual: z.string().trim().min(1, 'Enter the amount you counted.'),
  explanation: z.string().trim().max(500).optional(),
  adjust: z.string().optional(),
});

export async function reconcileAction(
  _previous: ReconcileFormState,
  formData: FormData,
): Promise<ReconcileFormState> {
  const actor = await requirePermission('reconciliation', 'create');

  const parsed = schema.safeParse({
    paymentAccountId: formData.get('paymentAccountId'),
    businessDate: formData.get('businessDate'),
    actual: formData.get('actual'),
    explanation: formData.get('explanation') ?? undefined,
    adjust: formData.get('adjust') ?? undefined,
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { fieldErrors };
  }

  let actual: Minor;
  try {
    actual = parseMoney(parsed.data.actual);
  } catch (error) {
    return {
      fieldErrors: { actual: isDomainError(error) ? error.userMessage : 'Invalid amount.' },
    };
  }

  if (actual < 0) {
    return { fieldErrors: { actual: 'A counted amount cannot be negative.' } };
  }

  try {
    const result = createReconciliation(
      db,
      {
        paymentAccountId: parsed.data.paymentAccountId,
        businessDate: parsed.data.businessDate,
        actual,
        explanation: parsed.data.explanation,
        adjust: parsed.data.adjust === 'on',
      },
      { id: actor.id, username: actor.username },
    );

    revalidatePath('/reconciliation');
    revalidatePath('/accounts');
    revalidatePath('/dashboard');

    return {
      reconciliationNo: result.reconciliationNo,
      differenceMinor: result.difference,
      adjusted: result.adjusted,
    };
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }
}

export async function voidReconciliationAction(
  reconciliationId: number,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('reconciliation', 'void');

  const reason = String(formData.get('reason') ?? '').trim();
  if (reason.length < 3) {
    return { fieldErrors: { reason: 'Give a reason for voiding this count.' } };
  }

  try {
    voidReconciliation(db, reconciliationId, reason, { id: actor.id, username: actor.username });
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/reconciliation');
  revalidatePath('/accounts');
  revalidatePath('/dashboard');
  redirect('/reconciliation?voided=1');
}
