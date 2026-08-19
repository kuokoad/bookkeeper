import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { search } from '@/services/search.service';
import { createProduct } from '@/services/catalog.service';
import { createCustomer } from '@/services/customer.service';
import { createSupplier } from '@/services/supplier.service';
import { minor, type Minor } from '@/domain/money';
import type { Principal } from '@/lib/auth/permissions';

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const m = (n: number): Minor => minor(n);

/** An owner sees everything; permissions are not consulted for OWNER. */
const OWNER: Principal = {
  id: 1,
  username: 'kwame',
  displayName: 'Kwame Owusu',
  role: 'OWNER',
  permissions: {},
};

/** Staff with only products granted. */
const PRODUCTS_ONLY: Principal = {
  id: 2,
  username: 'ama',
  displayName: 'Ama',
  role: 'STAFF',
  permissions: {
    products: { canView: true, canCreate: false, canEdit: false, canVoid: false },
  },
};

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');

  createProduct(
    context.db,
    { name: 'Milo Tin 400g', sku: 'MILO-400', costPrice: m(1_000), sellingPrice: m(1_400), unit: 'tin' },
    ACTOR,
  );
  createProduct(
    context.db,
    { name: 'Rice 5kg', sku: 'RICE-5', costPrice: m(5_000), sellingPrice: m(6_000), unit: 'bag' },
    ACTOR,
  );
  createCustomer(context.db, { name: 'Ama Serwaa', phone: '024 111 2222' }, ACTOR);
  createSupplier(context.db, { name: 'Madina Market Wholesale', phone: '030 999 8888' }, ACTOR);
});

afterEach(() => context.cleanup());

const titles = (results: ReturnType<typeof search>) =>
  results.groups.flatMap((group) => group.hits.map((hit) => hit.title));

describe('finding things', () => {
  it('matches a product by name', () => {
    expect(titles(search(context.db, 'Milo', OWNER))).toContain('Milo Tin 400g');
  });

  it('matches a product by its code', () => {
    expect(titles(search(context.db, 'RICE-5', OWNER))).toContain('Rice 5kg');
  });

  it('ignores case', () => {
    expect(titles(search(context.db, 'milo', OWNER))).toContain('Milo Tin 400g');
    expect(titles(search(context.db, 'MILO', OWNER))).toContain('Milo Tin 400g');
  });

  it('matches on part of a word', () => {
    expect(titles(search(context.db, 'adina', OWNER))).toContain('Madina Market Wholesale');
  });

  it('finds a customer by phone number', () => {
    expect(titles(search(context.db, '111 2222', OWNER))).toContain('Ama Serwaa');
  });

  it('groups results by what they are', () => {
    expect(search(context.db, 'milo', OWNER).groups.map((group) => group.label)).toEqual([
      'Products',
    ]);
    // "ma" appears in the customer and the supplier, but in neither product.
    expect(search(context.db, 'ma', OWNER).groups.map((group) => group.label)).toEqual([
      'Customers',
      'Suppliers',
    ]);
  });
});

describe('refusing to be useless', () => {
  it('says nothing for a single character rather than listing everything', () => {
    const results = search(context.db, 'a', OWNER);
    expect(results.total).toBe(0);
    expect(results.groups).toEqual([]);
  });

  it('handles an empty search', () => {
    expect(search(context.db, '', OWNER).total).toBe(0);
    expect(search(context.db, '   ', OWNER).total).toBe(0);
  });

  it('returns nothing for a term that matches nothing', () => {
    expect(search(context.db, 'zzzznothing', OWNER).total).toBe(0);
  });
});

describe('the wildcards in a search term', () => {
  it('treats % as a literal, not "match everything"', () => {
    // Unescaped, '%' would match every row in every table.
    expect(search(context.db, '%', OWNER).total).toBe(0);
    expect(search(context.db, '%%', OWNER).total).toBe(0);
  });

  it('treats _ as a literal too', () => {
    // '__' would match any two characters.
    expect(search(context.db, '__', OWNER).total).toBe(0);
  });
});

describe('permission', () => {
  it('searches only the record types the person may see', () => {
    // "ma" matches the customer AND the supplier, and neither product.
    const results = search(context.db, 'ma', PRODUCTS_ONLY);

    // A staff member without those permissions must not learn these records
    // exist, let alone read their phone numbers.
    expect(results.total).toBe(0);
    expect(results.groups.map((group) => group.label)).not.toContain('Customers');
    expect(results.groups.map((group) => group.label)).not.toContain('Suppliers');
    expect(titles(results)).not.toContain('Ama Serwaa');
    expect(titles(results)).not.toContain('Madina Market Wholesale');
  });

  it('still finds what that person IS allowed to see', () => {
    const results = search(context.db, 'milo', PRODUCTS_ONLY);
    expect(results.groups.map((group) => group.label)).toEqual(['Products']);
    expect(titles(results)).toContain('Milo Tin 400g');
  });

  it('gives an owner every group the term matches', () => {
    expect(search(context.db, 'milo', OWNER).groups.map((group) => group.label)).toContain(
      'Products',
    );
    const labels = search(context.db, 'ma', OWNER).groups.map((group) => group.label);
    expect(labels).toContain('Customers');
    expect(labels).toContain('Suppliers');
  });

  it('returns nothing at all for someone with no permissions', () => {
    const nobody: Principal = {
      id: 3,
      username: 'new',
      displayName: 'New Person',
      role: 'STAFF',
      permissions: {},
    };
    expect(search(context.db, 'ma', nobody).total).toBe(0);
  });
});

describe('searching for something containing a wildcard character', () => {
  /**
   * `%` and `_` mean "anything" to SQLite's LIKE, so a shop searching for a
   * product literally called "50% cotton" would otherwise match everything
   * containing "50". They are escaped — but escaping only works if the query
   * says so with an ESCAPE clause. Without one, SQLite reads the backslash as
   * an ordinary character to be matched, so the escaping turned a search that
   * found too much into one that found nothing at all.
   */
  beforeEach(() => {
    createProduct(
      context.db,
      { name: 'Cloth 50% cotton', costPrice: m(1_000), sellingPrice: m(1_500), unit: 'm' },
      ACTOR,
    );
    createProduct(
      context.db,
      { name: 'Cloth 5000 thread', costPrice: m(1_000), sellingPrice: m(1_500), unit: 'm' },
      ACTOR,
    );
    createProduct(
      context.db,
      { name: 'Tape A_B joiner', costPrice: m(500), sellingPrice: m(800), unit: 'pcs' },
      ACTOR,
    );
    createProduct(
      context.db,
      { name: 'Tape AXB joiner', costPrice: m(500), sellingPrice: m(800), unit: 'pcs' },
      ACTOR,
    );
  });

  const names = (query: string): string[] =>
    search(context.db, query, OWNER)
      .groups.flatMap((group) => group.hits)
      .map((hit) => hit.title);

  it('finds the one with a literal percent sign', () => {
    const found = names('50%');
    expect(found).toContain('Cloth 50% cotton');
    expect(found).not.toContain('Cloth 5000 thread');
  });

  it('treats an underscore as a character, not as "any character"', () => {
    const found = names('A_B');
    expect(found).toContain('Tape A_B joiner');
    expect(found).not.toContain('Tape AXB joiner');
  });

  it('still finds ordinary things', () => {
    expect(names('Cloth')).toEqual(
      expect.arrayContaining(['Cloth 50% cotton', 'Cloth 5000 thread']),
    );
  });
});
