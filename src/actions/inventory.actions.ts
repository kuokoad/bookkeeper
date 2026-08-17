'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { db } from '@/db/client';
import { requirePermission } from '@/lib/auth/current-user';
import {
  createStockAdjustment,
  voidStockAdjustment,
  type AdjustmentItemInput,
} from '@/services/stock-adjustment.service';
import { ADJUSTMENT_REASONS } from '@/db/schema/inventory';
import { parseMoney } from '@/domain/money';
import { parsePositiveQty } from '@/domain/quantity';
import { isDomainError } from '@/domain/errors';
import { isValidBusinessDate } from '@/lib/format';
import type { FormState } from './auth.actions';

/**
 * Stock adjustment actions.
 *
 * The form posts parallel arrays (productId[], direction[], qty[], value[]).
 * Every row is validated individually so the owner is told exactly which line
 * is wrong, and the whole document is rejected if any line is — a half-applied
 * adjustment is never written.
 */

const adjustmentSchema = z.object({
  businessDate: z
    .string()
    .refine(isValidBusinessDate, 'Enter a valid date.'),
  reason: z.enum(ADJUSTMENT_REASONS),
  note: z.string().trim().max(300).optional(),
});

export async function createAdjustmentAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('inventory', 'create');

  const parsed = adjustmentSchema.safeParse({
    businessDate: formData.get('businessDate'),
    reason: formData.get('reason'),
    note: formData.get('note') ?? undefined,
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { fieldErrors };
  }

  const productIds = formData.getAll('productId');
  const directions = formData.getAll('direction');
  const quantities = formData.getAll('qty');
  const values = formData.getAll('value');

  const items: AdjustmentItemInput[] = [];

  for (let index = 0; index < productIds.length; index++) {
    const rawProductId = String(productIds[index] ?? '').trim();
    const rawQty = String(quantities[index] ?? '').trim();

    // A blank row is simply not part of the document.
    if (rawProductId === '' || rawQty === '') continue;

    const productId = Number(rawProductId);
    if (!Number.isInteger(productId) || productId <= 0) {
      return { error: `Line ${index + 1}: choose a product.` };
    }

    const direction = String(directions[index] ?? 'OUT');
    if (direction !== 'IN' && direction !== 'OUT') {
      return { error: `Line ${index + 1}: choose whether stock is going in or out.` };
    }

    let qty;
    try {
      qty = parsePositiveQty(rawQty, `Line ${index + 1} quantity`);
    } catch (error) {
      return { error: isDomainError(error) ? error.userMessage : `Line ${index + 1}: bad quantity.` };
    }

    if (direction === 'IN') {
      const rawValue = String(values[index] ?? '').trim();
      if (rawValue === '') {
        return {
          error: `Line ${index + 1}: enter the total value of the stock being added.`,
        };
      }
      try {
        items.push({ productId, direction, qty, totalCost: parseMoney(rawValue) });
      } catch (error) {
        return { error: isDomainError(error) ? error.userMessage : `Line ${index + 1}: bad value.` };
      }
    } else {
      // Value is computed from the weighted average — never taken from the form.
      items.push({ productId, direction, qty });
    }
  }

  if (items.length === 0) {
    return { error: 'Add at least one product to the adjustment.' };
  }

  try {
    createStockAdjustment(
      db,
      {
        businessDate: parsed.data.businessDate,
        reason: parsed.data.reason,
        note: parsed.data.note,
        items,
      },
      { id: actor.id, username: actor.username },
    );
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/inventory');
  revalidatePath('/products');
  revalidatePath('/dashboard');
  redirect('/inventory/adjustments?created=1');
}

export async function voidAdjustmentAction(
  adjustmentId: number,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  // Voiding a posted financial document is the highest-risk inventory action.
  const actor = await requirePermission('inventory', 'void');

  const reason = String(formData.get('reason') ?? '').trim();
  if (reason.length < 3) {
    return { fieldErrors: { reason: 'Give a reason for voiding this adjustment.' } };
  }

  try {
    voidStockAdjustment(db, adjustmentId, reason, { id: actor.id, username: actor.username });
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/inventory');
  revalidatePath('/inventory/adjustments');
  revalidatePath('/products');
  revalidatePath('/dashboard');
  redirect('/inventory/adjustments?voided=1');
}
