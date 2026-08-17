'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { db } from '@/db/client';
import { requirePermission } from '@/lib/auth/current-user';
import { createSale, voidSale, type SaleLineRequest, type TenderRequest } from '@/services/sale.service';
import { recordCustomerPayment, voidCustomerPayment } from '@/services/customer-payment.service';
import { parseMoney, ZERO, type Minor } from '@/domain/money';
import { parsePositiveQty } from '@/domain/quantity';
import { isDomainError } from '@/domain/errors';
import { isValidBusinessDate } from '@/lib/format';
import type { FormState } from './auth.actions';

/**
 * Sales actions.
 *
 * The browser sends what was scanned and what was tendered. It does NOT send
 * totals — every figure is recomputed on the server from prices read out of the
 * database, so a tampered form cannot change what a sale is worth.
 */

export interface SaleFormState extends FormState {
  receiptNo?: string;
  saleId?: number;
  changeMinor?: number;
}

/** The cart, posted as one JSON field. Validated field by field below. */
const cartSchema = z.object({
  businessDate: z.string().refine(isValidBusinessDate, 'Enter a valid date.'),
  customerId: z.number().int().positive().nullable(),
  note: z.string().trim().max(300).optional(),
  invoiceDiscount: z.string().trim().optional(),
  items: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        qty: z.string().trim().min(1),
        unitPrice: z.string().trim().min(1),
        discount: z.string().trim().optional(),
      }),
    )
    .min(1, 'Add at least one item to the sale.'),
  tenders: z
    .array(
      z.object({
        paymentAccountId: z.number().int().positive(),
        amount: z.string().trim().min(1),
        reference: z.string().trim().max(80).optional(),
      }),
    )
    .default([]),
});

export async function createSaleAction(
  _previous: SaleFormState,
  formData: FormData,
): Promise<SaleFormState> {
  const actor = await requirePermission('sales', 'create');

  let payload: unknown;
  try {
    payload = JSON.parse(String(formData.get('cart') ?? '{}'));
  } catch {
    return { error: 'The sale could not be read. Please try again.' };
  }

  const parsed = cartSchema.safeParse(payload);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'The sale is incomplete.' };
  }

  const { businessDate, customerId, note, items, tenders, invoiceDiscount } = parsed.data;

  // Parse money and quantities with the strict domain parsers. Anything
  // ambiguous is rejected rather than coerced.
  const saleItems: SaleLineRequest[] = [];
  try {
    for (const [index, item] of items.entries()) {
      saleItems.push({
        productId: item.productId,
        qty: parsePositiveQty(item.qty, `Item ${index + 1} quantity`),
        unitPrice: parseMoney(item.unitPrice),
        ...(item.discount && item.discount.length > 0
          ? { discount: parseMoney(item.discount) }
          : {}),
      });
    }
  } catch (error) {
    return { error: isDomainError(error) ? error.userMessage : 'An item is not valid.' };
  }

  const saleTenders: TenderRequest[] = [];
  try {
    for (const tender of tenders) {
      const amount = parseMoney(tender.amount);
      if (amount <= 0) continue;
      saleTenders.push({
        paymentAccountId: tender.paymentAccountId,
        amount,
        ...(tender.reference ? { reference: tender.reference } : {}),
      });
    }
  } catch (error) {
    return { error: isDomainError(error) ? error.userMessage : 'A payment amount is not valid.' };
  }

  let discount: Minor = ZERO;
  if (invoiceDiscount && invoiceDiscount.length > 0) {
    try {
      discount = parseMoney(invoiceDiscount);
    } catch (error) {
      return { error: isDomainError(error) ? error.userMessage : 'The discount is not valid.' };
    }
  }

  try {
    const result = createSale(
      db,
      {
        businessDate,
        customerId,
        items: saleItems,
        invoiceDiscount: discount,
        tenders: saleTenders,
        note,
      },
      { id: actor.id, username: actor.username },
    );

    revalidatePath('/sales');
    revalidatePath('/products');
    revalidatePath('/inventory');
    revalidatePath('/dashboard');
    revalidatePath('/customers');

    return {
      receiptNo: result.receiptNo,
      saleId: result.saleId,
      changeMinor: result.change,
    };
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }
}

export async function voidSaleAction(
  saleId: number,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('sales', 'void');

  const reason = String(formData.get('reason') ?? '').trim();
  if (reason.length < 3) {
    return { fieldErrors: { reason: 'Give a reason for voiding this sale.' } };
  }

  try {
    voidSale(db, saleId, reason, { id: actor.id, username: actor.username });
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/sales');
  revalidatePath('/products');
  revalidatePath('/inventory');
  revalidatePath('/dashboard');
  revalidatePath('/customers');
  redirect(`/sales/${saleId}?voided=1`);
}

// --- customer payments ----------------------------------------------------

const paymentSchema = z.object({
  customerId: z.coerce.number().int().positive(),
  businessDate: z.string().refine(isValidBusinessDate, 'Enter a valid date.'),
  paymentAccountId: z.coerce.number().int().positive(),
  amount: z.string().trim().min(1, 'Enter an amount.'),
  reference: z.string().trim().max(80).optional(),
  note: z.string().trim().max(300).optional(),
});

export async function recordPaymentAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('customers', 'create');

  const parsed = paymentSchema.safeParse({
    customerId: formData.get('customerId'),
    businessDate: formData.get('businessDate'),
    paymentAccountId: formData.get('paymentAccountId'),
    amount: formData.get('amount'),
    reference: formData.get('reference') ?? undefined,
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

  let amount: Minor;
  try {
    amount = parseMoney(parsed.data.amount);
  } catch (error) {
    return {
      fieldErrors: { amount: isDomainError(error) ? error.userMessage : 'Invalid amount.' },
    };
  }

  try {
    recordCustomerPayment(
      db,
      {
        customerId: parsed.data.customerId,
        businessDate: parsed.data.businessDate,
        paymentAccountId: parsed.data.paymentAccountId,
        amount,
        reference: parsed.data.reference,
        note: parsed.data.note,
      },
      { id: actor.id, username: actor.username },
    );
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/customers');
  revalidatePath(`/customers/${parsed.data.customerId}`);
  revalidatePath('/sales');
  revalidatePath('/dashboard');
  redirect(`/customers/${parsed.data.customerId}?paid=1`);
}

export async function voidPaymentAction(
  paymentId: number,
  customerId: number,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('customers', 'void');

  const reason = String(formData.get('reason') ?? '').trim();
  if (reason.length < 3) {
    return { fieldErrors: { reason: 'Give a reason for voiding this payment.' } };
  }

  try {
    voidCustomerPayment(db, paymentId, reason, { id: actor.id, username: actor.username });
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/customers');
  revalidatePath(`/customers/${customerId}`);
  revalidatePath('/dashboard');
  redirect(`/customers/${customerId}?voided=1`);
}
