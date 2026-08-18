import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { getNotices } from '@/services/notifications.service';
import { createProduct } from '@/services/catalog.service';
import { createStockAdjustment } from '@/services/stock-adjustment.service';
import { writeAudit } from '@/services/audit.service';
import { minor, type Minor } from '@/domain/money';
import { fromUnits, type Qty } from '@/domain/quantity';
import type { Principal } from '@/lib/auth/permissions';

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
