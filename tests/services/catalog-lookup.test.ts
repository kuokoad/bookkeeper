import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { findProductByCode, getProduct, listProducts } from '@/services/catalog.service';
import { NotFoundError } from '@/domain/errors';

/**
 * Fetching ONE product must not depend on how many products the shop sells.
 *
 * `getProduct` used to ask for the first 500 products by name and look through
 * them in JavaScript. For a shop with a larger catalogue that is not slow, it is
 * WRONG: everything sorted after the five hundredth was unreachable, and
 * `getProduct` threw NotFoundError for a product sitting in the table.
 *
 * It reached the till. Scanning a barcode looks the product up by code — which
 * was always an indexed query and always correct — and then passes the id
 * through `getProduct`, so the scan failed for exactly the products a big shop
 * has most of.
 */

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };

/**
 * A catalogue too big for one page, written straight in so the test is about
 * the lookup rather than about the posting path. Names run "Product 0000"
 * upward so alphabetical order matches insertion order, which is what puts the
 * last one beyond the old limit.
 */
function buildCatalogue(count: number): { firstId: number; lastId: number } {
  const insert = context.connection.prepare(
    `INSERT INTO products (name, sku, barcode, unit, cost_price_minor, selling_price_minor,
                           track_inventory, qty_on_hand_milli, stock_value_minor,
                           is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'pcs', 500, 800, 1, 0, 0, 1, ?, ?)`,
  );

  let firstId = 0;
  let lastId = 0;
  const now = Date.now();
  const write = context.connection.transaction(() => {
    for (let index = 0; index < count; index++) {
      const padded = String(index).padStart(4, '0');
      const info = insert.run(`Product ${padded}`, `SKU-${padded}`, `BAR-${padded}`, now, now);
      const id = Number(info.lastInsertRowid);
      if (index === 0) firstId = id;
      lastId = id;
    }
  });
  write();

  return { firstId, lastId };
}

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(ACTOR.id, ACTOR.username, 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
});

afterEach(() => context.cleanup());

describe('a catalogue larger than one page', () => {
  const COUNT = 620;

  it('finds a product sorted past the old 500 limit', () => {
    const { lastId } = buildCatalogue(COUNT);

    // The old implementation threw NotFoundError here.
    const product = getProduct(context.db, lastId);
    expect(product.id).toBe(lastId);
    expect(product.name).toBe(`Product ${String(COUNT - 1).padStart(4, '0')}`);
  });

  it('still finds the first product', () => {
    const { firstId } = buildCatalogue(COUNT);
    expect(getProduct(context.db, firstId).name).toBe('Product 0000');
  });

  it('scans a barcode for a product past the limit', () => {
    // The till path, which is the reason this mattered.
    buildCatalogue(COUNT);
    const scanned = findProductByCode(context.db, `BAR-${String(COUNT - 1).padStart(4, '0')}`);

    expect(scanned).not.toBeNull();
    expect(scanned?.name).toBe(`Product ${String(COUNT - 1).padStart(4, '0')}`);
  });

  it('looks a product up by SKU past the limit too', () => {
    buildCatalogue(COUNT);
    const found = findProductByCode(context.db, `SKU-${String(COUNT - 1).padStart(4, '0')}`);
    expect(found?.name).toBe(`Product ${String(COUNT - 1).padStart(4, '0')}`);
  });
});

describe('the id filter', () => {
  it('returns exactly one product', () => {
    const { lastId } = buildCatalogue(10);
    const rows = listProducts(context.db, { includeInactive: true, id: lastId });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(lastId);
  });

  it('finds an archived product, which is what editing one needs', () => {
    const { lastId } = buildCatalogue(3);
    context.connection.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run(lastId);

    expect(getProduct(context.db, lastId).isActive).toBe(false);
    // …and it stays out of the ordinary list.
    expect(listProducts(context.db, {}).some((row) => row.id === lastId)).toBe(false);
  });

  it('still refuses an id that does not exist', () => {
    buildCatalogue(3);
    expect(() => getProduct(context.db, 999_999)).toThrow(NotFoundError);
  });
});
