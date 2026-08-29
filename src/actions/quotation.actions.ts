'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { db } from '@/db/client';
import { requirePermission } from '@/lib/auth/current-user';
import {
  cancelQuotation,
  convertQuotation,
  createQuotation,
  updateQuotation,
  type QuotationLineRequest,
} from '@/services/quotation.service';
import { parseMoney, type Minor } from '@/domain/money';
import { parseQty } from '@/domain/quantity';
import { isDomainError, ValidationError } from '@/domain/errors';
import { isValidBusinessDate } from '@/lib/format';
import type { FormState } from './auth.actions';

/**
 * Quotations, from the outside.
 *
 * Every export asks for the `quotations` permission before it reads a single
 * field. That module is not granted to a new staff account: quoting is where
 * margin is given away, and a price promised for thirty days is a decision the
 * shop owner makes.
 */

const lineSchema = z.object({
  productId: z.number().int().positive(),
  qty: z.string().trim().min(1),
  unitPrice: z.string().trim().min(1),
  discount: z.string().trim().optional(),
});

const quotationSchema = z.object({
  businessDate: z.string().refine(isValidBusinessDate, 'Enter a valid date.'),
  validUntil: z.string().refine(isValidBusinessDate, 'Enter a date the price is good until.'),
  customerName: z.string().trim().min(1, 'Say who the quote is for.').max(120),
  customerId: z.number().int().positive().nullable(),
  customerPhone: z.string().trim().max(40).optional(),
  reference: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(500).optional(),
  quoteDiscount: z.string().trim().optional(),
  lines: z.array(lineSchema).min(1, 'Add at least one item to the quote.'),
});

/** The JSON the quote editor submits, parsed once. */
function readForm(formData: FormData) {
  let lines: unknown = [];
  try {
    lines = JSON.parse(String(formData.get('lines') ?? '[]'));
  } catch {
    lines = [];
  }

  return quotationSchema.safeParse({
    businessDate: formData.get('businessDate'),
    validUntil: formData.get('validUntil'),
    customerName: formData.get('customerName'),
    customerId: formData.get('customerId') ? Number(formData.get('customerId')) : null,
    customerPhone: formData.get('customerPhone') || undefined,
    reference: formData.get('reference') || undefined,
    notes: formData.get('notes') || undefined,
    quoteDiscount: formData.get('quoteDiscount') || undefined,
    lines,
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
 * Quantities and prices are parsed by the DOMAIN, never by Zod.
 *
 * `parseQty` and `parseMoney` are the only things that know a quantity has
 * three decimal places and an amount is an integer count of pesewas. A schema
 * that coerced with `Number()` would accept 0.1 + 0.2 and put the difference
 * into a quote somebody signs.
 */
function toLines(
  raw: z.infer<typeof quotationSchema>['lines'],
): QuotationLineRequest[] {
  return raw.map((line) => ({
    productId: line.productId,
    qty: parseQty(line.qty),
    unitPrice: parseMoney(line.unitPrice),
    ...(line.discount ? { discount: parseMoney(line.discount) } : {}),
  }));
}

export async function createQuotationAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('quotations', 'create');

  const parsed = readForm(formData);
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  let quotationId: number;
  try {
    const created = createQuotation(
      db,
      {
        businessDate: parsed.data.businessDate,
        validUntil: parsed.data.validUntil,
        customerName: parsed.data.customerName,
        customerId: parsed.data.customerId,
        customerPhone: parsed.data.customerPhone ?? null,
        reference: parsed.data.reference ?? null,
        notes: parsed.data.notes ?? null,
        lines: toLines(parsed.data.lines),
        ...(parsed.data.quoteDiscount
          ? { quoteDiscount: parseMoney(parsed.data.quoteDiscount) }
          : {}),
      },
      actor,
    );
    quotationId = created.quotationId;
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/quotations');
  redirect(`/quotations/${quotationId}`);
}

export async function updateQuotationAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('quotations', 'edit');

  const quotationId = Number(formData.get('quotationId'));
  if (!Number.isInteger(quotationId) || quotationId <= 0) {
    return { error: 'That quote could not be identified. Please reload the page.' };
  }

  const parsed = readForm(formData);
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  try {
    updateQuotation(
      db,
      quotationId,
      {
        businessDate: parsed.data.businessDate,
        validUntil: parsed.data.validUntil,
        customerName: parsed.data.customerName,
        customerId: parsed.data.customerId,
        customerPhone: parsed.data.customerPhone ?? null,
        reference: parsed.data.reference ?? null,
        notes: parsed.data.notes ?? null,
        lines: toLines(parsed.data.lines),
        ...(parsed.data.quoteDiscount
          ? { quoteDiscount: parseMoney(parsed.data.quoteDiscount) }
          : {}),
      },
      actor,
    );
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/quotations');
  redirect(`/quotations/${quotationId}?saved=1`);
}

export async function cancelQuotationAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('quotations', 'void');

  const quotationId = Number(formData.get('quotationId'));
  const reason = String(formData.get('reason') ?? '').trim();
  if (!Number.isInteger(quotationId) || quotationId <= 0) {
    return { error: 'That quote could not be identified. Please reload the page.' };
  }
  if (reason === '') {
    return { fieldErrors: { reason: 'Say why the quote is being cancelled.' } };
  }

  try {
    cancelQuotation(db, quotationId, reason, actor);
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/quotations');
  redirect(`/quotations/${quotationId}?cancelled=1`);
}

const convertSchema = z.object({
  businessDate: z.string().refine(isValidBusinessDate, 'Enter a valid date.'),
  customerId: z.number().int().positive().nullable(),
  createCustomer: z.boolean(),
  termsDays: z.number().int().min(0).max(365).optional(),
  overrideReason: z.string().trim().max(300).optional(),
  tenders: z.array(
    z.object({
      paymentAccountId: z.number().int().positive(),
      amount: z.string().trim().min(1),
      reference: z.string().trim().max(80).optional(),
    }),
  ),
});

export async function convertQuotationAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('quotations', 'create');

  const quotationId = Number(formData.get('quotationId'));
  if (!Number.isInteger(quotationId) || quotationId <= 0) {
    return { error: 'That quote could not be identified. Please reload the page.' };
  }

  let tenders: unknown = [];
  try {
    tenders = JSON.parse(String(formData.get('tenders') ?? '[]'));
  } catch {
    tenders = [];
  }

  const parsed = convertSchema.safeParse({
    businessDate: formData.get('businessDate'),
    customerId: formData.get('customerId') ? Number(formData.get('customerId')) : null,
    createCustomer: formData.get('createCustomer') === 'on',
    termsDays: formData.get('termsDays') ? Number(formData.get('termsDays')) : undefined,
    overrideReason: formData.get('overrideReason') || undefined,
    tenders,
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  let saleId: number;
  try {
    const converted = convertQuotation(
      db,
      quotationId,
      {
        businessDate: parsed.data.businessDate,
        customerId: parsed.data.customerId,
        createCustomer: parsed.data.createCustomer,
        tenders: parsed.data.tenders.map((tender) => {
          const amount = parseMoney(tender.amount);
          if (amount < 0) throw new ValidationError('A payment cannot be negative.');
          return {
            paymentAccountId: tender.paymentAccountId,
            amount: amount as Minor,
            ...(tender.reference ? { reference: tender.reference } : {}),
          };
        }),
        ...(parsed.data.termsDays !== undefined ? { termsDays: parsed.data.termsDays } : {}),
        ...(parsed.data.overrideReason ? { overrideReason: parsed.data.overrideReason } : {}),
      },
      actor,
    );
    saleId = converted.saleId;
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  // Both, because a conversion changes the quote AND adds a sale.
  revalidatePath('/quotations');
  revalidatePath('/sales');
  redirect(`/sales/${saleId}?converted=1`);
}
