import { describe, expect, it } from 'vitest';

import { csvFilename, csvMoney, csvQty, escapeCsvField, toCsv } from '@/lib/csv';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, parseQty, type Qty } from '@/domain/quantity';

const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

describe('escaping', () => {
  it('leaves ordinary values alone', () => {
    expect(escapeCsvField('Milo 400g')).toBe('Milo 400g');
    expect(escapeCsvField(42)).toBe('42');
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });

  it('quotes fields containing commas, quotes or newlines', () => {
    expect(escapeCsvField('Rice, local')).toBe('"Rice, local"');
    expect(escapeCsvField('He said "hi"')).toBe('"He said ""hi"""');
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralises spreadsheet formula injection', () => {
    // A product name is user input, and Excel executes a cell starting with
    // these characters. Prefixing an apostrophe makes it literal text.
    expect(escapeCsvField('=1+1')).toBe("'=1+1");
    expect(escapeCsvField('+cmd')).toBe("'+cmd");
    expect(escapeCsvField('-2+3')).toBe("'-2+3");
    expect(escapeCsvField('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('leaves genuine negative numbers as numbers', () => {
    // The guard must not turn a loss into text the accountant cannot sum.
    expect(escapeCsvField('-704.85')).toBe('-704.85');
    expect(escapeCsvField('-1')).toBe('-1');
    expect(escapeCsvField(-25.5)).toBe('-25.5');
    expect(escapeCsvField(csvMoney(m(-70_485)))).toBe('-704.85');
  });

  it('quotes AND neutralises when both apply', () => {
    expect(escapeCsvField('=HYPERLINK("http://x"),y')).toBe(
      '"\'=HYPERLINK(""http://x""),y"',
    );
  });
});

describe('toCsv', () => {
  it('writes a header row and data rows with CRLF', () => {
    const csv = toCsv(['Name', 'Amount'], [['Milo', '46.00'], ['Bread', '12.00']]);
    expect(csv.startsWith('﻿')).toBe(true); // BOM for Excel
    expect(csv).toContain('Name,Amount\r\n');
    expect(csv).toContain('Milo,46.00\r\n');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('handles an empty result set without losing the headers', () => {
    const csv = toCsv(['Name', 'Amount'], []);
    expect(csv).toBe('﻿Name,Amount\r\n');
  });
});

describe('number formatting for spreadsheets', () => {
  it('writes money as a plain decimal a spreadsheet can sum', () => {
    expect(csvMoney(m(125_000))).toBe('1250.00');
    expect(csvMoney(m(5))).toBe('0.05');
    expect(csvMoney(m(-2_500))).toBe('-25.00');
    // No currency symbol, no thousands separator.
    expect(csvMoney(m(123_456_789))).not.toContain(',');
    expect(csvMoney(m(123_456_789))).not.toContain('GHS');
  });

  it('writes quantities without grouping', () => {
    expect(csvQty(u(3))).toBe('3');
    expect(csvQty(parseQty('2.5'))).toBe('2.5');
    expect(csvQty(parseQty('1200'))).toBe('1200');
  });
});

describe('filenames', () => {
  it('describes the report and its period', () => {
    expect(csvFilename('Profit and Loss', { from: '2026-08-01', to: '2026-08-31' })).toBe(
      'bookkeeper_profit-and-loss_2026-08-01_2026-08-31.csv',
    );
  });

  it('omits a duplicated single-day period', () => {
    expect(csvFilename('Sales', { from: '2026-08-17', to: '2026-08-17' })).toBe(
      'bookkeeper_sales_2026-08-17.csv',
    );
  });

  it('strips anything unsafe from the report name', () => {
    expect(csvFilename('Stock / Valuation!')).toBe('bookkeeper_stock-valuation-.csv');
  });
});
