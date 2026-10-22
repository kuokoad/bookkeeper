import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { products } from '@/db/schema';

/**
 * The import page saves only what its preview showed.
 *
 * The Import button shares a form with the column choices, so it posts
 * whatever those controls hold when clicked. A column switched after the last
 * preview must not reach the books unseen: the action shows the new preview
 * instead of importing.
 */

const database = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('@/db/client', () => ({
  get db() {
    return database.current;
  },
}));
vi.mock('@/lib/auth/current-user', () => ({
  requirePermission: async () => ({ id: 1, username: 'kwame' }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));

const { productImportAction } = await import('@/actions/catalog.actions');

let context: TestDatabase;

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
  database.current = context.db;
});
afterEach(() => context.cleanup());

// Column B is the shelf price, C the price with delivery.
const CELLS = [
  ['name', 'price', 'delivered price'],
  ['Bowl', '2.40', '3.00'],
];

function post(intent: string, priceColumn: string, previewedPriceColumn: string) {
  const form = new FormData();
  form.set('intent', intent);
  form.set('cells', JSON.stringify(CELLS));
  form.set('fileName', 'list.csv');
  form.set('column_name', '0');
  form.set('column_sellingPrice', priceColumn);
  form.set('packUnit', 'pack');
  form.set('previewed_name', '0');
  form.set('previewed_sellingPrice', previewedPriceColumn);
  form.set('previewedPackUnit', 'pack');
  return productImportAction({}, form);
}

describe('product import action', () => {
  it('refuses to import a price column the preview never showed, and previews it instead', async () => {
    const state = await post('import', '2', '1');

    expect(state.error).toMatch(/columns changed since the preview/);
    expect(state.preview?.rows[0]?.sellingPrice).toBe(300);
    expect(context.db.select().from(products).all()).toHaveLength(0);
  });

  it('imports when the columns are the ones previewed', async () => {
    await expect(post('import', '1', '1')).rejects.toThrow('REDIRECT /products?imported=1');
    expect(context.db.select().from(products).all().map((p) => p.sellingPriceMinor)).toEqual([240]);
  });
});
