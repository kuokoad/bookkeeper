import { toDecimalString, type Minor } from '@/domain/money';
import { formatQty, type Qty } from '@/domain/quantity';

/**
 * CSV generation.
 *
 * Money is written as a PLAIN decimal with no currency symbol and no thousands
 * separator (1250.00), so a spreadsheet reads it as a number rather than text.
 * That is the whole point of exporting — the owner's accountant should be able
 * to sum the column without cleaning it first.
 */

export type CsvValue = string | number | boolean | null | undefined;

/**
 * Escape one field.
 *
 * Also neutralises the leading characters that make a spreadsheet execute a
 * cell as a formula. A product named "=cmd|..." is a real injection vector when
 * the file is opened in Excel, and a shop's product names are user input.
 */
/** A plain number, including negatives and decimals. */
const NUMERIC = /^-?\d+(\.\d+)?$/;

export function escapeCsvField(value: CsvValue): string {
  if (value === null || value === undefined) return '';

  let text = String(value);

  // Genuine numbers are exempt: "-704.85" must stay a number a spreadsheet can
  // sum, not become text. Only non-numeric values starting with these
  // characters are neutralised.
  if (/^[=+\-@\t\r]/.test(text) && !NUMERIC.test(text)) {
    text = `'${text}`;
  }

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsv(headers: readonly string[], rows: readonly CsvValue[][]): string {
  const lines = [headers.map(escapeCsvField).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCsvField).join(','));
  }
  // CRLF and a BOM so Excel on Windows opens it correctly, including accents.
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Money for a spreadsheet column: no symbol, no grouping. */
export function csvMoney(value: Minor): string {
  return toDecimalString(value, false);
}

/** Quantity for a spreadsheet column. */
export function csvQty(value: Qty): string {
  return formatQty(value).replace(/,/g, '');
}

/** A safe, descriptive filename. */
export function csvFilename(report: string, period?: { from?: string; to?: string }): string {
  const parts = ['bookkeeper', report.replace(/[^a-z0-9]+/gi, '-').toLowerCase()];
  if (period?.from) parts.push(period.from);
  if (period?.to && period.to !== period.from) parts.push(period.to);
  return `${parts.join('_')}.csv`;
}

/** Build the HTTP response for a CSV download. */
export function csvResponse(filename: string, body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      // Reports are live figures; never let a proxy or the browser cache them.
      'Cache-Control': 'no-store',
    },
  });
}
