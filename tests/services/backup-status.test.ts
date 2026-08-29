import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { describeBackupStatus, getBackupStatus } from '@/services/backup.service';
import { getNotices } from '@/services/notifications.service';
import type { Principal } from '@/lib/auth/permissions';

/**
 * Whether the shop is backed up, and whether it needs telling.
 *
 * The database file IS the business records, and on a plan with no scheduled
 * tasks nothing takes a backup on the shop's behalf. A habit nobody can see is
 * a habit nobody can check, so this has to be answerable on screen.
 *
 * Two rules, and either one is enough to speak up. A week without a backup was
 * the original rule and is kept whatever has happened since. On top of it, ONE
 * day is enough once there is trading nobody has saved — the guidance is to back
 * up at the end of each trading day, and six more days of silence can cost a
 * busy shop a great deal.
 */

let context: TestDatabase;

const OWNER: Principal = {
  id: 1,
  username: 'kwame',
  displayName: 'Kwame',
  role: 'OWNER',
  permissions: {},
};

const DAY = 86_400_000;
const NOW = new Date('2026-08-24T18:00:00Z');

/** A backup taken at a given instant, as the download route records it. */
function recordBackupAt(at: number) {
  context.connection
    .prepare(
      `INSERT INTO audit_logs (user_id, username, action, entity_type, summary, created_at)
       VALUES (1, 'kwame', 'CREATE', 'backup', 'Downloaded a backup', ?)`,
    )
    .run(at);
}

/** A backup taken `daysAgo`, measured from the fixed NOW these tests pass in. */
function recordBackup(daysAgo: number) {
  recordBackupAt(NOW.getTime() - daysAgo * DAY);
}

/** A posted journal entry, as any sale or purchase would leave behind. */
function postEntry(daysAgo: number, no: string) {
  const at = NOW.getTime() - daysAgo * DAY;
  context.connection
    .prepare(
      `INSERT INTO journal_entries (entry_no, entry_date, occurred_at, source_type, source_id,
                                    memo, created_at)
       VALUES (?, '2026-08-20', ?, 'SALE', 1, 'test', ?)`,
    )
    .run(no, at, at);
}

beforeEach(() => {
  context = createTestDatabase();
  context.connection
    .prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?,?,?,?,?)')
    .run(1, 'kwame', 'Kwame', 'OWNER', 'scrypt$1$2$3$a$b');
});

afterEach(() => context.cleanup());

describe('a shop that has never backed up', () => {
  it('is told so even before it has traded', () => {
    // Not about what is at risk yet — about whether the shop is set up. Left
    // until the first sale, the habit is being started at the worst moment.
    const status = getBackupStatus(context.db, NOW);
    expect(status.state).toBe('never');
    expect(status.lastTakenAt).toBeNull();
    expect(describeBackupStatus(status)).toContain('start the habit now');
  });

  it('is told plainly once it has', () => {
    postEntry(0, 'JE-1');
    const status = getBackupStatus(context.db, NOW);

    expect(status.state).toBe('never');
    expect(status.entriesSince).toBe(1);
    expect(describeBackupStatus(status)).toContain('would be lost');
  });
});

describe('a shop that backed up and then traded', () => {
  it('is left alone on the same day', () => {
    recordBackup(0);
    postEntry(0, 'JE-1');
    expect(getBackupStatus(context.db, NOW).state).toBe('current');
  });

  it('is due after a day of unsaved trading', () => {
    recordBackup(2);
    postEntry(1, 'JE-1');

    const status = getBackupStatus(context.db, NOW);
    expect(status.state).toBe('due');
    expect(status.daysSince).toBe(2);
    expect(status.entriesSince).toBe(1);
  });

  it('agrees its verb with the count', () => {
    // "1 entry have been posted" is what happens when only the noun is
    // pluralised. Found by reading the actual screen, not the code.
    recordBackup(2);
    postEntry(1, 'JE-1');
    expect(describeBackupStatus(getBackupStatus(context.db, NOW))).toContain('1 entry has been');

    postEntry(1, 'JE-2');
    expect(describeBackupStatus(getBackupStatus(context.db, NOW))).toContain('2 entries have been');
  });

  it('is overdue after a week of it', () => {
    recordBackup(9);
    postEntry(3, 'JE-1');
    postEntry(1, 'JE-2');

    const status = getBackupStatus(context.db, NOW);
    expect(status.state).toBe('overdue');
    expect(status.entriesSince).toBe(2);
    expect(describeBackupStatus(status)).toContain('2 entries');
  });

  it('counts only what came after the backup', () => {
    postEntry(10, 'JE-old');
    recordBackup(5);
    postEntry(2, 'JE-new');

    expect(getBackupStatus(context.db, NOW).entriesSince).toBe(1);
  });
});

describe('a shop that is shut', () => {
  /**
   * The week rule still fires with nothing unsaved behind it. That is the
   * original behaviour and it is kept deliberately: a month-old backup is worth
   * mentioning even to a quiet shop, and the wording says plainly that nothing
   * has happened since, so it reads as a reminder rather than an alarm.
   */
  it('is still reminded, and told that nothing is at risk', () => {
    recordBackup(30);
    postEntry(45, 'JE-before-the-backup');

    const status = getBackupStatus(context.db, NOW);
    expect(status.state).toBe('overdue');
    expect(status.entriesSince).toBe(0);
    expect(describeBackupStatus(status)).toContain('nothing has been posted since');
  });

  it('is left alone inside the week when nothing has been posted', () => {
    recordBackup(3);
    postEntry(10, 'JE-before-the-backup');

    expect(getBackupStatus(context.db, NOW).state).toBe('current');
  });
});

describe('the most recent backup is the one that counts', () => {
  it('ignores older ones', () => {
    recordBackup(20);
    recordBackup(1);
    postEntry(0, 'JE-1');

    expect(getBackupStatus(context.db, NOW).daysSince).toBe(1);
  });
});

describe('what the owner actually sees', () => {
  it('gets a dashboard notice when trading is unsaved', () => {
    recordBackup(9);
    postEntry(1, 'JE-1');

    const notice = getNotices(context.db, OWNER).find((n) => n.id === 'stale-backup');
    expect(notice).toBeDefined();
    expect(notice?.href).toBe('/settings/health');
    expect(notice?.tone).toBe('danger');
  });

  it('gets nothing while the backup is recent and nothing is unsaved', () => {
    // Anchored on the REAL clock, for the reason spelled out in the next test:
    // `getNotices` reads `new Date()` itself, so a backup dated from the fixed
    // NOW drifts a day older every day and eventually trips the week rule. This
    // one passed when it was written and started failing five days later.
    recordBackupAt(Date.now() - 2 * DAY);
    const ids = getNotices(context.db, OWNER).map((n) => n.id);
    expect(ids).not.toContain('stale-backup');
    expect(ids).not.toContain('never-backed-up');
  });

  it('is told the day count when the week rule fires with nothing unsaved', () => {
    // Anchored on the real clock, not NOW: `getNotices` takes no date and reads
    // `new Date()` itself, so a backup dated from NOW drifts a day for every day
    // that passes and this asserted an exact count that only held on the day it
    // was written.
    recordBackupAt(Date.now() - 30 * DAY);
    const notice = getNotices(context.db, OWNER).find((n) => n.id === 'stale-backup');
    expect(notice?.title).toMatch(/30 days ago/);
  });

  it('does not show it to staff, who cannot take one', () => {
    // The backup button needs `settings:edit`. A notice somebody cannot act on
    // is noise to them.
    const staff: Principal = { ...OWNER, id: 2, username: 'ama', role: 'STAFF', permissions: {} };

    const ids = getNotices(context.db, staff).map((n) => n.id);
    expect(ids).not.toContain('never-backed-up');
    expect(ids).not.toContain('stale-backup');
  });
});
