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
import { createUnit, deleteUnit, updateUnit } from '@/services/units.service';
import {
  guessColumns,
  importProducts,
  MAX_IMPORT_ROWS,
  previewProductImport,
} from '@/services/product-import.service';
import { IMPORT_FIELDS, type ColumnMap, type ProductImportState } from '@/lib/product-import-fields';
import { readSpreadsheet } from '@/lib/spreadsheet';
import { toBusinessDate } from '@/lib/format';
import { parseMoney } from '@/domain/money';
import { parsePositiveQty, parseQty } from '@/domain/quantity';
import { ForbiddenError, isDomainError } from '@/domain/errors';
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
  unit: z.string().trim().min(1, 'Choose a unit.').max(20),
  altUnit: z.string().trim().max(20).optional(),
  altFactor: z.string().trim().optional(),
  altCostPrice: z.string().trim().optional(),
  altSellingPrice: z.string().trim().optional(),
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
    altUnit: formData.get('altUnit') ?? undefined,
    altFactor: formData.get('altFactor') ?? undefined,
    altCostPrice: formData.get('altCostPrice') ?? undefined,
    altSellingPrice: formData.get('altSellingPrice') ?? undefined,
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

  // The alternate unit: "1 Carton = 24 pcs", with optional prices of its own.
  let altFactor: number | null = null;
  let altCostPrice: number | null = null;
  let altSellingPrice: number | null = null;
  if (data.altUnit) {
    try {
      altFactor = parsePositiveQty(data.altFactor ?? '', 'The conversion');
    } catch (error) {
      fieldErrors['altFactor'] = isDomainError(error) ? error.userMessage : 'Invalid quantity.';
    }
    for (const [key, text] of [
      ['altCostPrice', data.altCostPrice],
      ['altSellingPrice', data.altSellingPrice],
    ] as const) {
      if (!text) continue;
      try {
        const value = parseMoney(text);
        if (key === 'altCostPrice') altCostPrice = value;
        else altSellingPrice = value;
      } catch (error) {
        fieldErrors[key] = isDomainError(error) ? error.userMessage : 'Invalid amount.';
      }
    }
  }

  return { costPrice, sellingPrice, minStock, warnDays, altFactor, altCostPrice, altSellingPrice, fieldErrors };
}

/** The unit fields as the service takes them. */
function altUnitInput(data: z.infer<typeof productSchema>, numbers: ReturnType<typeof parseProductNumbers>) {
  return {
    onlyListedUnits: true,
    altUnit: data.altUnit || null,
    altFactor: numbers.altFactor as never,
    altCostPrice: numbers.altCostPrice as never,
    altSellingPrice: numbers.altSellingPrice as never,
  };
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
        ...altUnitInput(parsed.data, numbers),
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
        ...altUnitInput(parsed.data, numbers),
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

// --- product import -------------------------------------------------------

/** Same limits on upload and on every later step, so a sheet that previews can always be imported. */
const MAX_CELL_LENGTH = 1_000;
const MAX_COLUMNS = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const cellsSchema = z
  .array(z.array(z.string().max(MAX_CELL_LENGTH)).max(MAX_COLUMNS))
  .min(1)
  .max(MAX_IMPORT_ROWS + 1);

/** Why these cells cannot be imported, in words, or null when they can. */
function cellsProblem(cells: string[][]): string | null {
  if (cells.length > MAX_IMPORT_ROWS + 1) {
    return `That sheet has more than ${MAX_IMPORT_ROWS} rows. Split it into smaller files.`;
  }
  if (cells.some((row) => row.length > MAX_COLUMNS)) {
    return `That sheet uses more than ${MAX_COLUMNS} columns. Delete the unused columns and try again.`;
  }
  const long = cells.findIndex((row) => row.some((cell) => cell.length > MAX_CELL_LENGTH));
  if (long >= 0) return `Row ${long + 1} has a cell longer than ${MAX_CELL_LENGTH} characters.`;
  return null;
}

/** Column choices posted under `prefix`; anything not a real column index means "not imported". */
function readColumnMap(formData: FormData, prefix: string, columns: number): ColumnMap {
  const map: ColumnMap = {};
  for (const { key } of IMPORT_FIELDS) {
    const text = formData.get(`${prefix}${key}`);
    const index = Number(text);
    if (typeof text === 'string' && text !== '' && Number.isInteger(index) && index >= 0 && index < columns) {
      map[key] = index;
    }
  }
  return map;
}

const sameChoices = (a: ColumnMap, b: ColumnMap) => IMPORT_FIELDS.every(({ key }) => a[key] === b[key]);

/**
 * One action for the three steps of the import page, chosen by the button
 * pressed: `upload` reads the file and guesses the columns, `preview` re-runs
 * with the owner's column choices, `import` creates the products. Only
 * `import` writes, and it re-checks every row on the server first.
 */
export async function productImportAction(
  previous: ProductImportState,
  formData: FormData,
): Promise<ProductImportState> {
  const actor = await requirePermission('products', 'create');
  const intent = formData.get('intent');

  let imported: number;
  let withStock: boolean;
  try {
    if (intent === 'upload') {
      const file = formData.get('file');
      if (!(file instanceof File) || file.size === 0) return { error: 'Choose a file to import.' };
      if (file.size > MAX_FILE_BYTES) return { error: 'That file is over 2 MB. Split it into smaller files.' };
      const cells = readSpreadsheet(file.name, new Uint8Array(await file.arrayBuffer()));
      if (cells.length < 2) return { error: 'That sheet has no rows under the headings.' };
      const problem = cellsProblem(cells);
      if (problem) return { error: problem };
      const map = guessColumns(cells[0] ?? []);
      const packUnit = 'pack';
      if (map.name === undefined) {
        return { fileName: file.name, cells, map, packUnit, error: 'Choose the column that holds the product name.' };
      }
      return { fileName: file.name, cells, map, packUnit, preview: previewProductImport(db, cells, map, packUnit) };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(String(formData.get('cells') ?? ''));
    } catch {
      raw = null;
    }
    const parsed = cellsSchema.safeParse(raw);
    if (!parsed.success) return { error: 'The uploaded sheet was lost. Choose the file again.' };
    const cells = parsed.data;
    const fileName = String(formData.get('fileName') ?? '').slice(0, 200);
    const columns = Math.max(...cells.map((row) => row.length));
    const map = readColumnMap(formData, 'column_', columns);
    const packUnit = String(formData.get('packUnit') ?? '').trim().slice(0, 20);

    // Import only what was on screen. A column or pack unit changed after the
    // last preview would save figures the owner never saw, so show them first.
    const previewed = readColumnMap(formData, 'previewed_', columns);
    const unchanged = sameChoices(map, previewed) && packUnit === String(formData.get('previewedPackUnit') ?? '');
    if (intent !== 'import' || !unchanged) {
      return {
        fileName,
        cells,
        map,
        packUnit,
        preview: previewProductImport(db, cells, map, packUnit),
        ...(intent === 'import'
          ? { error: 'The columns changed since the preview. Check the preview below, then import.' }
          : {}),
      };
    }
    // Opening stock is a stock adjustment, so it needs the right to record one.
    if (map.openingQty !== undefined) {
      await requirePermission('inventory', 'create').catch((error: unknown) => {
        if (!isDomainError(error) || error.code !== 'FORBIDDEN') throw error;
        throw new ForbiddenError(
          'import opening stock',
          'You can add products but not record stock. Set Opening quantity to "Not imported" to import the products alone.',
        );
      });
    }
    const result = importProducts(db, cells, map, packUnit, toBusinessDate(), { id: actor.id, username: actor.username });
    imported = result.created;
    withStock = result.adjustmentNo !== null;
  } catch (error) {
    if (!isDomainError(error)) throw error;
    // A failed upload must not leave the last file's columns on screen under the new error.
    if (intent === 'upload') return { error: error.userMessage };
    return { ...previous, preview: undefined, error: error.userMessage };
  }

  revalidatePath('/products');
  revalidatePath('/products/units');
  revalidatePath('/inventory');
  revalidatePath('/accounting');
  redirect(`/products?imported=${imported}${withStock ? '&openingStock=1' : ''}`);
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

// --- units of measure -----------------------------------------------------

const unitSchema = z.object({
  symbol: z.string().trim().min(1, 'Enter a symbol, e.g. pcs.').max(20),
  name: z.string().trim().min(1, 'Enter a name, e.g. Pieces.').max(60),
  decimalPlaces: z.coerce.number().int().min(0).max(3),
});

/**
 * Add a unit (`symbol` null) or change one. A rename carries every product
 * using the unit with it.
 */
export async function saveUnitAction(
  symbol: string | null,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('products', symbol === null ? 'create' : 'edit');

  const parsed = unitSchema.safeParse({
    symbol: formData.get('symbol'),
    name: formData.get('name'),
    decimalPlaces: formData.get('decimalPlaces') ?? 0,
  });
  if (!parsed.success) return { fieldErrors: collectFieldErrors(parsed.error) };

  try {
    const who = { id: actor.id, username: actor.username };
    if (symbol === null) createUnit(db, parsed.data, who);
    else updateUnit(db, symbol, parsed.data, who);
  } catch (error) {
    return toFormState(error);
  }

  revalidatePath('/products/units');
  revalidatePath('/products');
  return {};
}

export async function deleteUnitAction(symbol: string, _previous: FormState): Promise<FormState> {
  const actor = await requirePermission('products', 'edit');
  try {
    deleteUnit(db, symbol, { id: actor.id, username: actor.username });
  } catch (error) {
    return toFormState(error);
  }
  revalidatePath('/products/units');
  return {};
}
