'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { db } from '@/db/client';
import { requirePermission } from '@/lib/auth/current-user';
import {
  createPurchase,
  voidPurchase,
  type PurchaseLineRequest,
  type PurchaseTenderRequest,
} from '@/services/purchase.service';
import {
  recordSupplierPayment,
  voidSupplierPayment,
} from '@/services/supplier-payment.service';
import {
  createSupplier,
  setSupplierActive,
  updateSupplier,
} from '@/services/supplier.service';
import { createCustomerReturn, createSupplierReturn } from '@/services/returns.service';
import { parseMoney, ZERO, type Minor } from '@/domain/money';
import { parsePositiveQty } from '@/domain/quantity';
import { isDomainError } from '@/domain/errors';
import { isValidBusinessDate } from '@/lib/format';
import type { FormState } from './auth.actions';

/**
 * Purchases, suppliers and returns.
 *
 * As everywhere else, the browser sends what was bought and what was paid; the
 * server recomputes every total from its own data before writing anything.
 */

function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  return fieldErrors;
}

// --- suppliers ------------------------------------------------------------

const supplierSchema = z.object({
  name: z.string().trim().min(1, 'Enter the supplier’s name.').max(120),
  contactPerson: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().max(120).optional(),
  address: z.string().trim().max(300).optional(),
  notes: z.string().trim().max(500).optional(),
});

function readSupplierForm(formData: FormData) {
  return supplierSchema.safeParse({
    name: formData.get('name'),
    contactPerson: formData.get('contactPerson') ?? undefined,
    phone: formData.get('phone') ?? undefined,
    email: formData.get('email') ?? undefined,
    address: formData.get('address') ?? undefined,
    notes: formData.get('notes') ?? undefined,
  });
}

export async function createSupplierAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('suppliers', 'create');
  const parsed = readSupplierForm(formData);
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  let supplierId: number;
  try {
    supplierId = createSupplier(db, parsed.data, { id: actor.id, username: actor.username });
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/suppliers');
  redirect(`/suppliers/${supplierId}?created=1`);
}

export async function updateSupplierAction(
  supplierId: number,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('suppliers', 'edit');
  const parsed = readSupplierForm(formData);
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  try {
    updateSupplier(db, supplierId, parsed.data, { id: actor.id, username: actor.username });
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/suppliers');
  revalidatePath(`/suppliers/${supplierId}`);
  redirect(`/suppliers/${supplierId}?updated=1`);
}

export async function setSupplierActiveAction(
  supplierId: number,
  isActive: boolean,
): Promise<void> {
  const actor = await requirePermission('suppliers', 'edit');
  setSupplierActive(db, supplierId, isActive, { id: actor.id, username: actor.username });
  revalidatePath('/suppliers');
}

// --- purchases ------------------------------------------------------------

export interface PurchaseFormState extends FormState {
  purchaseNo?: string;
  purchaseId?: number;
}

const purchaseSchema = z.object({
  supplierId: z.number().int().positive(),
  businessDate: z.string().refine(isValidBusinessDate, 'Enter a valid date.'),
  invoiceNo: z.string().trim().max(60).optional(),
  note: z.string().trim().max(300).optional(),
  invoiceDiscount: z.string().trim().optional(),
  items: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        qty: z.string().trim().min(1),
        unitCost: z.string().trim().min(1),
        discount: z.string().trim().optional(),
      }),
    )
    .min(1, 'Add at least one product to the purchase.'),
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

export async function createPurchaseAction(
  _previous: PurchaseFormState,
  formData: FormData,
): Promise<PurchaseFormState> {
  const actor = await requirePermission('purchases', 'create');

  let payload: unknown;
  try {
    payload = JSON.parse(String(formData.get('basket') ?? '{}'));
  } catch {
    return { error: 'The purchase could not be read. Please try again.' };
  }

  const parsed = purchaseSchema.safeParse(payload);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'The purchase is incomplete.' };
  }

  const items: PurchaseLineRequest[] = [];
  try {
    for (const [index, item] of parsed.data.items.entries()) {
      items.push({
        productId: item.productId,
        qty: parsePositiveQty(item.qty, `Line ${index + 1} quantity`),
        unitCost: parseMoney(item.unitCost),
        ...(item.discount && item.discount.length > 0
          ? { discount: parseMoney(item.discount) }
          : {}),
      });
    }
  } catch (error) {
    return { error: isDomainError(error) ? error.userMessage : 'A line is not valid.' };
  }

  const tenders: PurchaseTenderRequest[] = [];
  try {
    for (const tender of parsed.data.tenders) {
      const amount = parseMoney(tender.amount);
      if (amount <= 0) continue;
      tenders.push({
        paymentAccountId: tender.paymentAccountId,
        amount,
        ...(tender.reference ? { reference: tender.reference } : {}),
      });
    }
  } catch (error) {
    return { error: isDomainError(error) ? error.userMessage : 'A payment amount is not valid.' };
  }

  let discount: Minor = ZERO;
  if (parsed.data.invoiceDiscount && parsed.data.invoiceDiscount.length > 0) {
    try {
      discount = parseMoney(parsed.data.invoiceDiscount);
    } catch (error) {
      return { error: isDomainError(error) ? error.userMessage : 'The discount is not valid.' };
    }
  }

  try {
    const result = createPurchase(
      db,
      {
        supplierId: parsed.data.supplierId,
        businessDate: parsed.data.businessDate,
        invoiceNo: parsed.data.invoiceNo,
        items,
        invoiceDiscount: discount,
        tenders,
        note: parsed.data.note,
      },
      { id: actor.id, username: actor.username },
    );

    revalidatePath('/purchases');
    revalidatePath('/products');
    revalidatePath('/inventory');
    revalidatePath('/suppliers');
    revalidatePath('/dashboard');

    return { purchaseNo: result.purchaseNo, purchaseId: result.purchaseId };
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }
}

export async function voidPurchaseAction(
  purchaseId: number,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('purchases', 'void');

  const reason = String(formData.get('reason') ?? '').trim();
  if (reason.length < 3) {
    return { fieldErrors: { reason: 'Give a reason for voiding this purchase.' } };
  }

  try {
    voidPurchase(db, purchaseId, reason, { id: actor.id, username: actor.username });
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/purchases');
  revalidatePath('/products');
  revalidatePath('/inventory');
  revalidatePath('/suppliers');
  redirect(`/purchases/${purchaseId}?voided=1`);
}

// --- supplier payments ----------------------------------------------------

const supplierPaymentSchema = z.object({
  supplierId: z.coerce.number().int().positive(),
  businessDate: z.string().refine(isValidBusinessDate, 'Enter a valid date.'),
  paymentAccountId: z.coerce.number().int().positive(),
  amount: z.string().trim().min(1, 'Enter an amount.'),
  reference: z.string().trim().max(80).optional(),
  note: z.string().trim().max(300).optional(),
});

export async function paySupplierAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('suppliers', 'create');

  const parsed = supplierPaymentSchema.safeParse({
    supplierId: formData.get('supplierId'),
    businessDate: formData.get('businessDate'),
    paymentAccountId: formData.get('paymentAccountId'),
    amount: formData.get('amount'),
    reference: formData.get('reference') ?? undefined,
    note: formData.get('note') ?? undefined,
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

  try {
    recordSupplierPayment(
      db,
      {
        supplierId: parsed.data.supplierId,
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

  revalidatePath('/suppliers');
  revalidatePath(`/suppliers/${parsed.data.supplierId}`);
  revalidatePath('/purchases');
  revalidatePath('/dashboard');
  redirect(`/suppliers/${parsed.data.supplierId}?paid=1`);
}

export async function voidSupplierPaymentAction(
  paymentId: number,
  supplierId: number,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('suppliers', 'void');

  const reason = String(formData.get('reason') ?? '').trim();
  if (reason.length < 3) {
    return { fieldErrors: { reason: 'Give a reason for voiding this payment.' } };
  }

  try {
    voidSupplierPayment(db, paymentId, reason, { id: actor.id, username: actor.username });
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath(`/suppliers/${supplierId}`);
  revalidatePath('/dashboard');
  redirect(`/suppliers/${supplierId}?voided=1`);
}

// --- returns --------------------------------------------------------------

/**
 * A return form posts one quantity per original line. Lines left blank are not
 * part of the return; the whole document is refused if any line is invalid.
 */
function readReturnLines(
  formData: FormData,
): { itemId: number; qty: ReturnType<typeof parsePositiveQty> }[] | { error: string } {
  const itemIds = formData.getAll('itemId');
  const quantities = formData.getAll('qty');
  const lines: { itemId: number; qty: ReturnType<typeof parsePositiveQty> }[] = [];

  for (let index = 0; index < itemIds.length; index++) {
    const rawQty = String(quantities[index] ?? '').trim();
    if (rawQty === '' || rawQty === '0') continue;

    const itemId = Number(itemIds[index]);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      return { error: `Line ${index + 1} is not valid.` };
    }

    try {
      lines.push({ itemId, qty: parsePositiveQty(rawQty, `Line ${index + 1} quantity`) });
    } catch (error) {
      return { error: isDomainError(error) ? error.userMessage : `Line ${index + 1} is not valid.` };
    }
  }

  return lines;
}

export async function createCustomerReturnAction(
  saleId: number,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('sales', 'create');

  const businessDate = String(formData.get('businessDate') ?? '');
  if (!isValidBusinessDate(businessDate)) {
    return { fieldErrors: { businessDate: 'Enter a valid date.' } };
  }

  const lines = readReturnLines(formData);
  if ('error' in lines) return { error: lines.error };
  if (lines.length === 0) return { error: 'Enter a quantity for at least one item.' };

  const refundAccountId = Number(formData.get('refundAccountId') ?? 0);
  const rawRefund = String(formData.get('refundAmount') ?? '').trim();
  const refunds: { paymentAccountId: number; amount: Minor }[] = [];

  if (rawRefund !== '' && Number.isInteger(refundAccountId) && refundAccountId > 0) {
    try {
      const amount = parseMoney(rawRefund);
      if (amount > 0) refunds.push({ paymentAccountId: refundAccountId, amount });
    } catch (error) {
      return {
        fieldErrors: {
          refundAmount: isDomainError(error) ? error.userMessage : 'Invalid amount.',
        },
      };
    }
  }

  try {
    createCustomerReturn(
      db,
      saleId,
      {
        businessDate,
        items: lines,
        refunds,
        reason: String(formData.get('reason') ?? '').trim() || undefined,
      },
      { id: actor.id, username: actor.username },
    );
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/sales');
  revalidatePath(`/sales/${saleId}`);
  revalidatePath('/products');
  revalidatePath('/inventory');
  revalidatePath('/customers');
  revalidatePath('/dashboard');
  redirect(`/sales/${saleId}?returned=1`);
}

export async function createSupplierReturnAction(
  purchaseId: number,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('purchases', 'create');

  const businessDate = String(formData.get('businessDate') ?? '');
  if (!isValidBusinessDate(businessDate)) {
    return { fieldErrors: { businessDate: 'Enter a valid date.' } };
  }

  const lines = readReturnLines(formData);
  if ('error' in lines) return { error: lines.error };
  if (lines.length === 0) return { error: 'Enter a quantity for at least one item.' };

  const refundAccountId = Number(formData.get('refundAccountId') ?? 0);
  const rawRefund = String(formData.get('refundAmount') ?? '').trim();
  const refunds: { paymentAccountId: number; amount: Minor }[] = [];

  if (rawRefund !== '' && Number.isInteger(refundAccountId) && refundAccountId > 0) {
    try {
      const amount = parseMoney(rawRefund);
      if (amount > 0) refunds.push({ paymentAccountId: refundAccountId, amount });
    } catch (error) {
      return {
        fieldErrors: {
          refundAmount: isDomainError(error) ? error.userMessage : 'Invalid amount.',
        },
      };
    }
  }

  try {
    createSupplierReturn(
      db,
      purchaseId,
      {
        businessDate,
        items: lines,
        refunds,
        reason: String(formData.get('reason') ?? '').trim() || undefined,
      },
      { id: actor.id, username: actor.username },
    );
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/purchases');
  revalidatePath(`/purchases/${purchaseId}`);
  revalidatePath('/products');
  revalidatePath('/inventory');
  revalidatePath('/suppliers');
  revalidatePath('/dashboard');
  redirect(`/purchases/${purchaseId}?returned=1`);
}
