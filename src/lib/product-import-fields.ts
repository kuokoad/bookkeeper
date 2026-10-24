import type { Minor } from '@/domain/money';
import type { Qty } from '@/domain/quantity';

/**
 * The shape of a product import, shared by the import service and the page
 * that previews it. No database code here, so the browser bundle can use it.
 */

export const IMPORT_FIELDS = [
  { key: 'name', label: 'Product name' },
  { key: 'sku', label: 'Code / SKU' },
  { key: 'barcode', label: 'Barcode' },
  { key: 'unit', label: 'Unit' },
  { key: 'costPrice', label: 'Cost price (per unit)' },
  { key: 'sellingPrice', label: 'Selling price (per unit)' },
  { key: 'altFactor', label: 'Units per pack' },
  { key: 'altCostPrice', label: 'Cost per pack' },
  { key: 'altSellingPrice', label: 'Selling price per pack' },
  { key: 'minStock', label: 'Reorder level' },
  { key: 'category', label: 'Category' },
  { key: 'trackInventory', label: 'Track stock (yes / no)' },
  { key: 'openingQty', label: 'Opening quantity' },
  { key: 'openingValue', label: 'Opening stock value' },
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number]['key'];
/** Which spreadsheet column (zero-based) feeds each field. Absent = not imported. */
export type ColumnMap = Partial<Record<ImportField, number>>;

export interface PreviewRow {
  /** The spreadsheet row number, as Excel shows it. */
  line: number;
  name: string;
  sku: string;
  unit: string;
  costPrice: Minor;
  sellingPrice: Minor;
  altUnit: string | null;
  altFactor: Qty | null;
  altCostPrice: Minor | null;
  altSellingPrice: Minor | null;
  categoryId: number | null;
  categoryName: string | null;
  trackInventory: boolean;
  /** Opening stock in the base unit, or null for none. */
  openingQty: Qty | null;
  /** What that opening stock is worth; set whenever `openingQty` is. */
  openingValue: Minor | null;
  /** Why the row will NOT be imported. Empty means it will be. */
  problems: string[];
  /** Things changed on the way in — rounding, a worked-out price — that the owner should see. */
  notes: string[];
}

export interface ImportPreview {
  rows: PreviewRow[];
  /** Units not on the Units list yet, which the import would add. */
  newUnits: string[];
  /** Warnings about the file as a whole, e.g. two columns with the same heading. */
  warnings: string[];
  ready: number;
  skipped: number;
  /** Total opening stock value of the ready rows: what the import would post to Inventory. */
  openingValue: Minor;
}

/** What the import page carries between its steps. */
export interface ProductImportState {
  error?: string;
  fileName?: string;
  /** The raw cells, carried back unchanged so the import re-reads exactly what was previewed. */
  cells?: string[][];
  map?: ColumnMap;
  packUnit?: string;
  preview?: ImportPreview;
}
