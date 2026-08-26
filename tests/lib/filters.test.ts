import { describe, expect, it } from 'vitest';

import {
  buildQuery,
  clampPage,
  DATE_PRESETS,
  describeDateRange,
  EARLIEST_DATE,
  parseAmount,
  parseAmountRange,
  parseDate,
  parseEnum,
  parseId,
  parsePage,
  parseSearch,
  parseSort,
  resolveDateRange,
  sanitiseFilterQuery,
  withParam,
} from '@/lib/filters';

/**
 * The filter parsers.
 *
 * Everything here answers one of two questions: does a filter mean what a shop
 * owner thinks it means, and does junk in a query string narrow nothing rather
 * than break the page. Both matter more than they look: a date range that quietly
 * excludes the last day of the month understates a month's takings, and a
 * hand-edited URL must never reach SQL.
 */

// A Saturday, chosen so the Monday-start week rule is actually exercised.
const TODAY = '2026-08-15';

describe('date ranges', () => {
  it('includes both ends of an explicit range', () => {
    const { range, preset } = resolveDateRange('custom', '2026-08-01', '2026-08-15', TODAY);
    expect(preset).toBe('custom');
    expect(range).toEqual({ from: '2026-08-01', to: '2026-08-15' });
  });

  /**
   * The one that costs a shop money if it is wrong.
   *
   * Business dates are stored as 'YYYY-MM-DD' text and compared as text, so
   * 1–15 August covers every sale dated the 15th whatever time of day it was
   * rung up. Filtering on a timestamp instead would drop the evening's takings
   * on the last day of every range the shop ever looks at.
   */
  it('covers a whole day at the end of a range, whatever time a sale happened', () => {
    const { range } = resolveDateRange('custom', '2026-08-01', '2026-08-15', TODAY);
    const lateEvening = '2026-08-15';
    expect(lateEvening >= range.from && lateEvening <= range.to).toBe(true);
  });

  it('answers today and yesterday', () => {
    expect(resolveDateRange('today', undefined, undefined, TODAY).range).toEqual({
      from: '2026-08-15',
      to: '2026-08-15',
    });
    expect(resolveDateRange('yesterday', undefined, undefined, TODAY).range).toEqual({
      from: '2026-08-14',
      to: '2026-08-14',
    });
  });

  it('starts the week on Monday', () => {
    // 15 August 2026 is a Saturday; that week's Monday is the 10th.
    expect(resolveDateRange('week', undefined, undefined, TODAY).range).toEqual({
      from: '2026-08-10',
      to: '2026-08-15',
    });
  });

  it('gives last week as a complete Monday-to-Sunday week', () => {
    expect(resolveDateRange('last-week', undefined, undefined, TODAY).range).toEqual({
      from: '2026-08-03',
      to: '2026-08-09',
    });
  });

  it('gives this month from the first, and last month in full', () => {
    expect(resolveDateRange('month', undefined, undefined, TODAY).range).toEqual({
      from: '2026-08-01',
      to: '2026-08-15',
    });
    expect(resolveDateRange('last-month', undefined, undefined, TODAY).range).toEqual({
      from: '2026-07-01',
      to: '2026-07-31',
    });
  });

  it('handles a last-month that ends on the 29th of a leap February', () => {
    expect(resolveDateRange('last-month', undefined, undefined, '2028-03-10').range).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
  });

  it('gives this year from the first of January', () => {
    expect(resolveDateRange('year', undefined, undefined, TODAY).range).toEqual({
      from: '2026-01-01',
      to: '2026-08-15',
    });
  });

  it('treats "everything" as a real range, so from is always <= to', () => {
    const { range } = resolveDateRange('all', undefined, undefined, TODAY);
    expect(range.from).toBe(EARLIEST_DATE);
    expect(range.from <= range.to).toBe(true);
  });

  it('falls back to this month for anything it does not recognise', () => {
    for (const junk of ['', 'fortnight', 'DROP TABLE sales', '../../etc']) {
      const { preset, range } = resolveDateRange(junk, undefined, undefined, TODAY);
      expect(preset).toBe('month');
      expect(range).toEqual({ from: '2026-08-01', to: '2026-08-15' });
    }
  });

  it('swaps a custom range entered the wrong way round rather than showing nothing', () => {
    const { range } = resolveDateRange('custom', '2026-08-31', '2026-08-01', TODAY);
    expect(range).toEqual({ from: '2026-08-01', to: '2026-08-31' });
  });

  it('accepts a custom range with only one end filled in', () => {
    expect(resolveDateRange('custom', '2026-08-05', undefined, TODAY).range).toEqual({
      from: '2026-08-05',
      to: TODAY,
    });
    expect(resolveDateRange('custom', undefined, '2026-08-05', TODAY).range).toEqual({
      from: EARLIEST_DATE,
      to: '2026-08-05',
    });
  });

  it('ignores an unparseable custom date instead of passing it to SQL', () => {
    const { preset } = resolveDateRange('custom', 'yesterday', "'; DROP TABLE sales; --", TODAY);
    expect(preset).toBe('month');
  });

  it('rejects a date that looks right but is not a real day', () => {
    expect(resolveDateRange('custom', '2026-02-30', undefined, TODAY).preset).toBe('month');
  });

  it('describes every preset without throwing', () => {
    for (const preset of DATE_PRESETS) {
      const { range, preset: resolved } = resolveDateRange(preset, TODAY, TODAY, TODAY);
      expect(describeDateRange(range, resolved, TODAY).length).toBeGreaterThan(0);
    }
  });
});

describe('scalar parsers', () => {
  it('accepts a positive integer id and nothing else', () => {
    expect(parseId('7')).toBe(7);
    for (const junk of ['0', '-1', '1.5', 'abc', '', ' ', '1 OR 1=1', '9e99']) {
      expect(parseId(junk)).toBeUndefined();
    }
    expect(parseId(undefined)).toBeUndefined();
  });

  it('accepts only whitelisted enum values', () => {
    const allowed = ['paid', 'unpaid'] as const;
    expect(parseEnum('paid', allowed)).toBe('paid');
    expect(parseEnum('PAID', allowed)).toBeUndefined();
    expect(parseEnum('anything', allowed)).toBeUndefined();
    expect(parseEnum(undefined, allowed)).toBeUndefined();
  });

  it('accepts only a real business date', () => {
    expect(parseDate('2026-08-15')).toBe('2026-08-15');
    expect(parseDate('2026-8-5')).toBeUndefined();
    expect(parseDate('2026-13-01')).toBeUndefined();
    expect(parseDate(undefined)).toBeUndefined();
  });

  it('trims a search term and treats blank as no filter', () => {
    expect(parseSearch('  coca cola ')).toBe('coca cola');
    expect(parseSearch('   ')).toBeUndefined();
    expect(parseSearch('')).toBeUndefined();
    expect(parseSearch('x'.repeat(500))?.length).toBe(100);
  });

  it('parses an amount into minor units and shrugs off a typo', () => {
    expect(parseAmount('50')).toBe(5_000);
    expect(parseAmount('1,250.50')).toBe(125_050);
    expect(parseAmount('GHS 20')).toBe(2_000);
    // A filter box is a question, not a posting. A typo narrows nothing.
    expect(parseAmount('abc')).toBeUndefined();
    expect(parseAmount('')).toBeUndefined();
    expect(parseAmount(undefined)).toBeUndefined();
  });

  it('puts an amount range back in order when it is entered backwards', () => {
    expect(parseAmountRange('500', '100')).toEqual({ minAmount: 10_000, maxAmount: 50_000 });
    expect(parseAmountRange('100', undefined)).toEqual({ minAmount: 10_000 });
    expect(parseAmountRange(undefined, '100')).toEqual({ maxAmount: 10_000 });
    expect(parseAmountRange(undefined, undefined)).toEqual({});
  });
});

describe('sorting', () => {
  const allowed = ['date', 'amount'] as const;

  it('falls back rather than letting a query string reach an ORDER BY', () => {
    expect(parseSort('amount', 'asc', allowed, 'date')).toEqual({
      sort: 'amount',
      direction: 'asc',
    });
    expect(parseSort('total_minor; DROP TABLE sales', 'asc', allowed, 'date').sort).toBe('date');
    expect(parseSort('date', 'sideways', allowed, 'date').direction).toBe('desc');
  });
});

describe('pagination', () => {
  it('starts at page one for anything that is not a page number', () => {
    for (const junk of ['0', '-4', 'abc', '1.5', '']) {
      expect(parsePage(junk).page).toBe(1);
    }
    expect(parsePage(undefined).page).toBe(1);
  });

  it('turns a page into an offset', () => {
    expect(parsePage('3', 50)).toEqual({ page: 3, pageSize: 50, offset: 100 });
  });

  it('caps the page size so one request cannot ask for everything', () => {
    expect(parsePage('1', 10_000).pageSize).toBe(200);
  });

  /**
   * Filtering 1,000 sales down to 27 while the URL still says page 4 must show
   * the last page, not an empty table under a pager insisting there are results.
   */
  it('clamps a page number to what the filtered set can actually show', () => {
    expect(clampPage(4, 27, 50)).toBe(1);
    expect(clampPage(4, 260, 50)).toBe(4);
    expect(clampPage(9, 260, 50)).toBe(6);
    expect(clampPage(1, 0, 50)).toBe(1);
  });
});

describe('the return trip from a form', () => {
  /**
   * Recording or voiding a cashbook row posts to a server action and lands back
   * on the list. The query string comes back through a hidden form field, which
   * makes it untrusted input on the way to a redirect.
   */
  it('keeps the filters the list was showing', () => {
    expect(sanitiseFilterQuery('period=last-month&q=rent&category=5')).toBe(
      'period=last-month&q=rent&category=5',
    );
  });

  it('drops anything that is not a filter key', () => {
    expect(sanitiseFilterQuery('q=rent&evil=1&__proto__=x&created=1')).toBe('q=rent');
  });

  /**
   * The defence that matters: this takes a query string and returns a query
   * string, so a redirect built from it cannot be pointed at another host or
   * another path however the field is stuffed.
   */
  it('cannot be turned into an open redirect', () => {
    for (const attack of [
      'https://evil.example.com',
      '//evil.example.com',
      '/../../admin',
      'q=x&next=https://evil.example.com',
      'javascript:alert(1)',
    ]) {
      const result = sanitiseFilterQuery(attack);
      expect(result).not.toContain('evil.example.com');
      expect(result).not.toContain('javascript:');
      expect(result.startsWith('/')).toBe(false);
      expect(result.startsWith('http')).toBe(false);
    }
  });

  it('shrugs off a missing or non-string field', () => {
    expect(sanitiseFilterQuery(undefined)).toBe('');
    expect(sanitiseFilterQuery(null)).toBe('');
    expect(sanitiseFilterQuery(42)).toBe('');
    expect(sanitiseFilterQuery(new File([], 'x'))).toBe('');
  });

  it('refuses a value long enough to be a payload rather than a filter', () => {
    expect(sanitiseFilterQuery(`q=${'x'.repeat(500)}`)).toBe('');
    expect(sanitiseFilterQuery(`q=${'x'.repeat(100)}`)).not.toBe('');
  });

  it('accepts the string with or without its leading question mark', () => {
    expect(sanitiseFilterQuery('?q=rent')).toBe('q=rent');
    expect(sanitiseFilterQuery('q=rent')).toBe('q=rent');
  });
});

describe('query strings', () => {
  it('drops empty values so a cleared filter leaves no trace in the URL', () => {
    expect(buildQuery({ q: 'rice', customer: undefined, category: '' })).toBe('?q=rice');
    expect(buildQuery({})).toBe('');
  });

  it('carries every other filter when one changes', () => {
    const values = { period: 'month', q: 'rice', category: 3 };
    expect(withParam(values, 'page', 2)).toBe('?period=month&q=rice&category=3&page=2');
    // Clearing the page key removes it rather than writing page=undefined.
    expect(withParam(values, 'page', undefined)).toBe('?period=month&q=rice&category=3');
  });

  it('escapes a search term rather than splicing it into the URL', () => {
    expect(buildQuery({ q: 'a&b=c d' })).toBe('?q=a%26b%3Dc+d');
  });
});
