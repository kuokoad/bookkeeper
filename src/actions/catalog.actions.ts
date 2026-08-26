'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { db } from '@/db/client';
import { requirePermission } from '@/lib/auth/current-user';
import {
  createCategory,
  createProduct,
  setCategoryActive,
  setProductActive,
  updateCategory,
  updateProduct,
} from '@/services/catalog.service';
import { parseMoney } from '@/domain/money';
import { parseQty } from '@/domain/quantity';
import { isDomainError } from '@/domain/errors';
import type { FormState } from './auth.actions';

/**
 * Server actions for the catalogue.
 *
 * Each one re-checks the permission on the SERVER from the session cookie, then
 * re-validates every field. Nothing sent by the browser is trusted, including
 * the numbers — money and quantities are parsed from text by the domain
 * parsers, which reject anything ambiguous rather than coercing it.
 */

function collectFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  return fieldErrors;
}

/** Turn a thrown domain error into a message a shop owner can act on. */
function toFormState(error: unknown): FormState {
  if (isDomainError(error)) return { error: error.userMessage };
  throw error;
}

// --- products -------------------------------------------------------------

const productSchema = z.object({
  name: z.string().trim().min(1, 'Enter a product name.').max(160),
  sku: z.string().trim().max(60).optional(),
  barcode: z.string().trim().max(60).optional(),
  categoryId: z.string().optional(),
  unit: z.string().trim().min(1, 'Enter a unit.').max(20),
  description: z.string().trim().max(500).optional(),
  costPrice: z.string().trim().min(1, 'Enter a cost price.'),
  sellingPrice: z.string().trim().min(1, 'Enter a selling price.'),
  minStock: z.string().trim().optional(),
  warnDays: z.string().trim().optional(),
  trackInventory: z.string().optional(),
});

function readProductForm(formData: FormData) {
  return productSchema.safeParse({
    name: formData.get('name'),
    sku: formData.get('sku') ?? undefined,
    barcode: formData.get('barcode') ?? undefined,
    categoryId: formData.get('categoryId') ?? undefined,
    unit: formData.get('unit') ?? 'pcs',
    description: formData.get('description') ?? undefined,
    costPrice: formData.get('costPrice'),
    sellingPrice: formData.get('sellingPrice'),
    minStock: formData.get('minStock') ?? undefined,
    warnDays: formData.get('warnDays') ?? undefined,
    trackInventory: formData.get('trackInventory') ?? undefined,
  });
}

/** Parse the numeric fields, reporting per-field errors rather than one blob. */
function parseProductNumbers(data: z.infer<typeof productSchema>) {
  const fieldErrors: Record<string, string> = {};
  let costPrice = 0;
  let sellingPrice = 0;
  let minStock: number | null = null;
  let warnDays: number | null = null;

  try {
    costPrice = parseMoney(data.costPrice);
  } catch (error) {
    fieldErrors['costPrice'] = isDomainError(error) ? error.userMessage : 'Invalid amount.';
  }
  try {
    sellingPrice = parseMoney(data.sellingPrice);
  } catch (error) {
    fieldErrors['sellingPrice'] = isDomainError(error) ? error.userMessage : 'Invalid amount.';
  }
  if (data.minStock && data.minStock.length > 0) {
    try {
      minStock = parseQty(data.minStock);
    } catch (error) {
      fieldErrors['minStock'] = isDomainError(error) ? error.userMessage : 'Invalid quantity.';
    }
  }

  if (data.warnDays && data.warnDays.length > 0) {
    const days = Number(data.warnDays);
    if (!Number.isInteger(days) || days < 0) {
      fieldErrors['warnDays'] = 'Enter a whole number of days, or leave it blank.';
    } else if (days > 3_650) {
      fieldErrors['warnDays'] = 'A warning further than ten years ahead is not useful.';
    } else {
      warnDays = days;
    }
  }

  return { costPrice, sellingPrice, minStock, warnDays, fieldErrors };
}

export async function createProductAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('products', 'create');

  const parsed = readProductForm(formData);
  if (!parsed.success) return { fieldErrors: collectFieldErrors(parsed.error) };

  const numbers = parseProductNumbers(parsed.data);
  if (Object.keys(numbers.fieldErrors).length > 0) return { fieldErrors: numbers.fieldErrors };

  const categoryId = parsed.data.categoryId ? Number(parsed.data.categoryId) : null;

  try {
    createProduct(
      db,
      {
        name: parsed.data.name,
        sku: parsed.data.sku,
        barcode: parsed.data.barcode,
        categoryId: Number.isFinite(categoryId) ? categoryId : null,
        unit: parsed.data.unit,
        description: parsed.data.description,
        costPrice: numbers.costPrice as never,
        sellingPrice: numbers.sellingPrice as never,
        minStock: numbers.minStock as never,
        warnDays: numbers.warnDays,
        trackInventory: parsed.data.trackInventory === 'on',
      },
      { id: actor.id, username: actor.username },
    );
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath('/products');
  revalidatePath('/inventory');
  redirect('/products?created=1');
}

export async function updateProductAction(
  productId: number,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('products', 'edit');

  const parsed = readProductForm(formData);
  if (!parsed.success) return { fieldErrors: collectFieldErrors(parsed.error) };

  const numbers = parseProductNumbers(parsed.data);
  if (Object.keys(numbers.fieldErrors).length > 0) return { fieldErrors: numbers.fieldErrors };

  const categoryId = parsed.data.categoryId ? Number(parsed.data.categoryId) : null;

  try {
    updateProduct(
      db,
      productId,
      {
        name: parsed.data.name,
        sku: parsed.data.sku,
        barcode: parsed.data.barcode,
        categoryId: Number.isFinite(categoryId) ? categoryId : null,
        unit: parsed.data.unit,
        description: parsed.data.description,
        costPrice: numbers.costPrice as never,
        sellingPrice: numbers.sellingPrice as never,
        minStock: numbers.minStock as never,
        warnDays: numbers.warnDays,
        trackInventory: parsed.data.trackInventory === 'on',
      },
      { id: actor.id, username: actor.username },
    );
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath('/products');
  revalidatePath(`/products/${productId}`);
  redirect(`/products?updated=1`);
}

export async function setProductActiveAction(productId: number, isActive: boolean): Promise<void> {
  const actor = await requirePermission('products', 'edit');
  setProductActive(db, productId, isActive, { id: actor.id, username: actor.username });
  revalidatePath('/products');
}

// --- categories -----------------------------------------------------------

const categorySchema = z.object({
  name: z.string().trim().min(1, 'Enter a category name.').max(80),
  description: z.string().trim().max(300).optional(),
});

export async function createCategoryAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('products', 'create');

  const parsed = categorySchema.safeParse({
    name: formData.get('name'),
    description: formData.get('description') ?? undefined,
  });
  if (!parsed.success) return { fieldErrors: collectFieldErrors(parsed.error) };

  try {
    createCategory(db, parsed.data, { id: actor.id, username: actor.username });
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath('/products/categories');
  revalidatePath('/products');
  return {};
}

export async function updateCategoryAction(
  categoryId: number,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('products', 'edit');

  const parsed = categorySchema.safeParse({
    name: formData.get('name'),
    description: formData.get('description') ?? undefined,
  });
  if (!parsed.success) return { fieldErrors: collectFieldErrors(parsed.error) };

  try {
    updateCategory(db, categoryId, parsed.data, { id: actor.id, username: actor.username });
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath('/products/categories');
  return {};
}

export async function setCategoryActiveAction(
  categoryId: number,
  isActive: boolean,
): Promise<void> {
  const actor = await requirePermission('products', 'edit');
  setCategoryActive(db, categoryId, isActive, { id: actor.id, username: actor.username });
  revalidatePath('/products/categories');
}
