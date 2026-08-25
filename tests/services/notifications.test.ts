import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { getNotices } from '@/services/notifications.service';
import { createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { recordStockMovement, verifyBatchCoverage } from '@/services/inventory.service';
import { writeTransaction } from '@/db/transaction';
import { productBatches, stockAdjustmentItems } from '@/db/schema';
import { ValidationError } from '@/domain/errors';
import { writeAudit } from '@/services/audit.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';
import type { Principal } from '@/lib/auth/permissions';
import { addDays } from '@/domain/business-date';
import { toBusinessDate } from '@/lib/format';

let context: TestDatabase;
const ACTOR = { id: 1, username: 'kwame' };
const m = (n: number): Minor => minor(n);
const u = (n: number): Qty => fromUnits(n);

const OWNER: Principal = {
  id: 1,
  username: 'kwame',
  displayName: 'Kwame Owusu',
  role: 'OWNER',
  permissions: {},
};

const TILL_STAFF: Principal = {
  id: 2,
  username: 'ama',
  displayName: 'Ama',
  role: 'STAFF',
  permissions: { sales: { canView: true, canCreate: true, canEdit: false, canVoid: false } },
};

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
});

afterEach(() => context.cleanup());

const ids = (user: Principal) => getNotices(context.db, user).map((notice) => notice.id);

describe('what the owner is told', () => {
  it('warns that no backup has ever been taken', () => {
    expect(ids(OWNER)).toContain('never-backed-up');
  });

  it('stops warning once a backup is recorded', () => {
    writeAudit(context.db, {
      action: 'CREATE',
      entityType: 'backup',
      userId: 1,
      username: 'kwame',
      summary: 'Downloaded a backup',
    });

    expect(ids(OWNER)).not.toContain('never-backed-up');
    expect(ids(OWNER)).not.toContain('stale-backup');
  });

  it('warns again when the last backup is old', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
    writeAudit(context.db, {
      action: 'CREATE',
      entityType: 'backup',
      userId: 1,
      username: 'kwame',
      summary: 'Downloaded a backup',
      at: eightDaysAgo,
    });

    const notice = getNotices(context.db, OWNER).find((entry) => entry.id === 'stale-backup');
    expect(notice?.title).toMatch(/8 days ago/);
  });

  it('reports products that have run out', () => {
    const productId = createProduct(
      context.db,
      { name: 'Milo', costPrice: m(1_000), sellingPrice: m(1_400), unit: 'tin' },
      ACTOR,
    );
    createStockAdjustment(
      context.db,
      {
        businessDate: '2026-08-16',
        reason: 'OPENING_STOCK',
        items: [{ productId, direction: 'IN', qty: u(10), totalCost: m(10_000) }],
      },
      ACTOR,
    );
    createStockAdjustment(
      context.db,
      {
        businessDate: '2026-08-17',
        reason: 'DAMAGED',
        items: [{ productId, direction: 'OUT', qty: u(10) }],
      },
      ACTOR,
    );

    expect(ids(OWNER)).toContain('out-of-stock');
  });
});

describe('every notice is a real condition', () => {
  it('says nothing about stock when there is no stock problem', () => {
    const notices = ids(OWNER);
    expect(notices).not.toContain('out-of-stock');
    expect(notices).not.toContain('low-stock');
  });

  it('says nothing about overdue money when nobody owes anything', () => {
    expect(ids(OWNER)).not.toContain('overdue');
  });

  it('does not claim the books are broken when they balance', () => {
    expect(ids(OWNER)).not.toContain('unbalanced');
  });

  it('every notice links somewhere that can act on it', () => {
    for (const notice of getNotices(context.db, OWNER)) {
      expect(notice.href.startsWith('/'), notice.id).toBe(true);
      expect(notice.title.length, notice.id).toBeGreaterThan(0);
      expect(notice.detail.length, notice.id).toBeGreaterThan(0);
    }
  });
});

describe('permission', () => {
  it('does not show till staff the owner housekeeping', () => {
    // Backups and year-end are not theirs to act on, and the nudge would be
    // noise they cannot clear.
    const staffNotices = ids(TILL_STAFF);
    expect(staffNotices).not.toContain('never-backed-up');
    expect(staffNotices).not.toContain('year-open');
  });

  it('does not show stock warnings to someone who cannot see products', () => {
    expect(ids(TILL_STAFF)).not.toContain('low-stock');
    expect(ids(TILL_STAFF)).not.toContain('out-of-stock');
  });

  it('shows unbalanced books to EVERYONE', () => {
    // If the ledger is broken, nothing on any screen can be trusted, whatever
    // the person is allowed to do.
    context.connection
      .prepare('UPDATE journal_lines SET debit_minor = debit_minor + 1 WHERE debit_minor > 0')
      .run();

    // Only meaningful if there were lines to break; with none, both are clean.
    const owner = ids(OWNER);
    const staff = ids(TILL_STAFF);
    expect(owner.includes('unbalanced')).toBe(staff.includes('unbalanced'));
  });
});

/**
 * Dates relative to the real clock.
 *
 * `getNotices` takes no date and reads `new Date()` itself, so a test written
 * against a fixed literal is true on the day it was written and drifts into
 * nonsense afterwards — '2026-09-10' is "expiring soon" this week and "expired"
 * next month. Anchoring on today keeps the intent stable.
 */
const inDays = (days: number): string => addDays(toBusinessDate(), days);

describe('being told about dates', () => {
  /**
   * Two notices, and which one appears matters more than that they exist.
   *
   * Stock that has already turned crowds out the warning about stock that is
   * going to, exactly as out-of-stock crowds out running-low. A shelf with both
   * problems is one problem to deal with, and two rows about it is how a
   * dashboard becomes wallpaper.
   *
   * Neither appears at all in a shop that dates nothing, which is most shops on
   * the day they install this.
   */
  const TODAY = toBusinessDate();

  function deliver(productId: number, qtyUnits: number, expiryDate: string | null) {
    return writeTransaction(context.db, (tx) =>
      recordStockMovement(tx, {
        productId,
        direction: 'IN',
        qty: u(qtyUnits),
        totalCost: m(100 * qtyUnits),
        movementType: 'PURCHASE',
        sourceType: 'TEST',
        businessDate: inDays(-25),
        occurredAt: new Date(),
        userId: 1,
        batch: { kind: 'NEW', expiryDate },
      }),
    );
  }

  function stocked(name: string): number {
    return createProduct(
      context.db,
      { name, costPrice: m(100), sellingPrice: m(200), unit: 'pcs' },
      ACTOR,
    );
  }

  it('says nothing at all when no stock carries a date', () => {
    const milk = stocked('Rice 5kg');
    deliver(milk, 20, null);

    const notices = ids(OWNER);
    expect(notices).not.toContain('expired-stock');
    expect(notices).not.toContain('expiring-soon');
  });

  it('says nothing while every date is comfortably ahead', () => {
    const milk = stocked('Milo 400g');
    deliver(milk, 20, inDays(300));

    expect(ids(OWNER)).not.toContain('expiring-soon');
  });

  it('warns when a date falls inside the window', () => {
    const milk = stocked('Evaporated Milk');
    deliver(milk, 20, inDays(16));

    const notice = getNotices(context.db, OWNER).find((row) => row.id === 'expiring-soon');
    expect(notice).toBeDefined();
    expect(notice!.tone).toBe('warning');
    expect(notice!.title).toContain('1 product');
    expect(notice!.title).toContain('30 days');
    expect(notice!.href).toBe('/products?expiring=soon');
  });

  it('counts products rather than crates, because that is what gets dealt with', () => {
    const milk = stocked('Evaporated Milk');
    deliver(milk, 10, inDays(7));
    deliver(milk, 10, inDays(14));

    const notice = getNotices(context.db, OWNER).find((row) => row.id === 'expiring-soon');
    expect(notice!.title).toContain('1 product');
  });

  it('raises it to danger once something has actually turned', () => {
    const milk = stocked('Evaporated Milk');
    deliver(milk, 20, inDays(-24));

    const notice = getNotices(context.db, OWNER).find((row) => row.id === 'expired-stock');
    expect(notice).toBeDefined();
    expect(notice!.tone).toBe('danger');
    expect(notice!.href).toBe('/products?expiring=expired');
  });

  it('lets the expired notice crowd out the expiring one', () => {
    const milk = stocked('Evaporated Milk');
    const bread = stocked('Tea Bread');
    deliver(milk, 20, inDays(-24)); // gone
    deliver(bread, 20, inDays(16)); // going

    const notices = ids(OWNER);
    expect(notices).toContain('expired-stock');
    expect(notices).not.toContain('expiring-soon');
  });

  it('stops mentioning a crate once it is emptied', () => {
    const milk = stocked('Evaporated Milk');
    deliver(milk, 20, inDays(-24));
    expect(ids(OWNER)).toContain('expired-stock');

    const batch = context.db.select().from(productBatches).all()[0]!;
    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'EXPIRED',
        items: [{ productId: milk, direction: 'OUT', qty: u(20), batchId: batch.id }],
      },
      ACTOR,
    );

    expect(ids(OWNER)).not.toContain('expired-stock');
  });

  it('hides both from someone who cannot see products', () => {
    const milk = stocked('Evaporated Milk');
    deliver(milk, 20, inDays(-24));

    const staff = ids(TILL_STAFF);
    expect(staff).not.toContain('expired-stock');
    expect(staff).not.toContain('expiring-soon');
  });
});

describe('writing off what has expired', () => {
  const TODAY = toBusinessDate();

  function deliver(productId: number, qtyUnits: number, expiryDate: string | null) {
    return writeTransaction(context.db, (tx) =>
      recordStockMovement(tx, {
        productId,
        direction: 'IN',
        qty: u(qtyUnits),
        totalCost: m(100 * qtyUnits),
        movementType: 'PURCHASE',
        sourceType: 'TEST',
        businessDate: inDays(-25),
        occurredAt: new Date(),
        userId: 1,
        batch: { kind: 'NEW', expiryDate },
      }),
    ).batchAllocations[0]!.batchId;
  }

  function stocked(name: string): number {
    return createProduct(
      context.db,
      { name, costPrice: m(100), sellingPrice: m(200), unit: 'pcs' },
      ACTOR,
    );
  }

  const expectCovered = (label: string) => {
    for (const row of verifyBatchCoverage(context.db)) {
      expect(row.ok, `${label}: product ${row.productId}`).toBe(true);
    }
  };

  it('empties the named crate and closes it, leaving the good stock alone', () => {
    const milk = stocked('Evaporated Milk');
    const gone = deliver(milk, 6, inDays(-24));
    const good = deliver(milk, 10, inDays(98));

    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'EXPIRED',
        items: [{ productId: milk, direction: 'OUT', qty: u(6), batchId: gone }],
      },
      ACTOR,
    );

    const held = new Map(
      context.db
        .select()
        .from(productBatches)
        .all()
        .map((batch) => [batch.id, batch]),
    );
    expect(held.get(gone)!.qtyMilli).toBe(0);
    expect(held.get(gone)!.isClosed).toBe(true);
    expect(held.get(good)!.qtyMilli).toBe(10_000);
    expectCovered('named write-off');
  });

  it('records which crate it was, on the item itself', () => {
    const milk = stocked('Evaporated Milk');
    const gone = deliver(milk, 6, inDays(-24));

    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'EXPIRED',
        items: [{ productId: milk, direction: 'OUT', qty: u(6), batchId: gone }],
      },
      ACTOR,
    );

    const item = context.db.select().from(stockAdjustmentItems).all()[0]!;
    expect(item.batchId).toBe(gone);
  });

  it('takes the expired stock first when no crate is named', () => {
    // The rule that matters: pick by soonest date instead and the write-off
    // removes the GOOD stock and leaves the bad crate on the shelf.
    const milk = stocked('Evaporated Milk');
    const gone = deliver(milk, 6, inDays(-24));
    const good = deliver(milk, 10, inDays(98));

    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'EXPIRED',
        items: [{ productId: milk, direction: 'OUT', qty: u(6) }],
      },
      ACTOR,
    );

    const held = new Map(
      context.db
        .select()
        .from(productBatches)
        .all()
        .map((batch) => [batch.id, batch.qtyMilli]),
    );
    expect(held.get(gone)).toBe(0);
    expect(held.get(good)).toBe(10_000);
    expectCovered('unnamed write-off');
  });

  it('still works for a shop that dates nothing', () => {
    const bread = stocked('Tea Bread');
    deliver(bread, 10, null);

    createStockAdjustment(
      context.db,
      {
        businessDate: TODAY,
        reason: 'EXPIRED',
        items: [{ productId: bread, direction: 'OUT', qty: u(4) }],
      },
      ACTOR,
    );

    expect(context.db.select().from(productBatches).all()[0]!.qtyMilli).toBe(6_000);
    expectCovered('undated write-off');
  });

  it('refuses a crate belonging to another product', () => {
    const milk = stocked('Evaporated Milk');
    const bread = stocked('Tea Bread');
    const theirs = deliver(bread, 6, inDays(-24));
    deliver(milk, 6, inDays(-24));

    expect(() =>
      createStockAdjustment(
        context.db,
        {
          businessDate: TODAY,
          reason: 'EXPIRED',
          items: [{ productId: milk, direction: 'OUT', qty: u(6), batchId: theirs }],
        },
        ACTOR,
      ),
    ).toThrow(ValidationError);
  });

  it('refuses to write off more than the crate holds', () => {
    const milk = stocked('Evaporated Milk');
    const gone = deliver(milk, 6, inDays(-24));
    deliver(milk, 20, inDays(98));

    expect(() =>
      createStockAdjustment(
        context.db,
        {
          businessDate: TODAY,
          reason: 'EXPIRED',
          items: [{ productId: milk, direction: 'OUT', qty: u(10), batchId: gone }],
        },
        ACTOR,
      ),
    ).toThrow(ValidationError);
  });

  it('refuses a crate on a reason that has no business naming one', () => {
    // A recount tells you the shelf is wrong, not which crate is.
    const milk = stocked('Evaporated Milk');
    const batch = deliver(milk, 6, inDays(98));

    expect(() =>
      createStockAdjustment(
        context.db,
        {
          businessDate: TODAY,
          reason: 'COUNT_CORRECTION',
          items: [{ productId: milk, direction: 'OUT', qty: u(2), batchId: batch }],
        },
        ACTOR,
      ),
    ).toThrow(ValidationError);
  });
});
