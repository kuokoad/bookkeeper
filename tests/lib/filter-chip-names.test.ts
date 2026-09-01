import { describe, expect, it } from 'vitest';

import { filterValueName } from '@/lib/filters';

/**
 * What a filter chip calls the record it points at.
 *
 * Six list pages each carried their own copy of this lookup, and every one of
 * them fell back to printing the id when nothing matched. A stale bookmark or a
 * hand-edited query string then produced `Customer: 999999` sitting above an
 * empty table: a filter nobody set, described in a number nobody can read, with
 * no way to tell an archived customer from a broken link.
 *
 * The filter itself is left alone. A well-formed id for a record that is not
 * there is not junk to be thrown away — "sales for customer 999999" honestly
 * has no rows, the same way `/customers/999999` honestly returns Not found. It
 * is only the label that has to stop pretending the number means something.
 */

const CUSTOMERS = [
  { id: 1, name: 'Adom Construction Ltd' },
  { id: 2, name: 'Mensah & Sons Builders' },
];

const STAFF = [
  { id: 1, displayName: 'Demo Owner' },
  { id: 2, displayName: 'Ama' },
];

describe('the name on a filter chip', () => {
  it('is the record name when the id resolves', () => {
    expect(filterValueName(CUSTOMERS, 1)).toBe('Adom Construction Ltd');
    expect(filterValueName(CUSTOMERS, 2)).toBe('Mensah & Sons Builders');
  });

  it('falls back to displayName for the lists that carry one', () => {
    expect(filterValueName(STAFF, 2)).toBe('Ama');
  });

  it('never prints a bare id for a record that is not there', () => {
    const value = filterValueName(CUSTOMERS, 999999);

    expect(value).toBe('no longer listed');
    expect(value).not.toContain('999999');
  });

  it('says the same thing for an empty list as for a missing row', () => {
    expect(filterValueName([], 1)).toBe('no longer listed');
  });
});
