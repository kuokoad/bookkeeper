import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { auditLogs, sessions, userPermissions, users } from '@/db/schema';
import { createUser, login, loginWithPin, MAX_FAILED_LOGINS } from '@/services/auth.service';
import {
  changeOwnPassword,
  getUser,
  getUserPermissions,
  listUsers,
  resetUserPassword,
  setUserActive,
  setUserPermissions,
  setUserPin,
  unlockUser,
  updateUser,
} from '@/services/user.service';
import * as auditService from '@/services/audit.service';
import { countAuditLogs, listAuditEntityTypes, listAuditLogs } from '@/services/audit.service';
import { validateSessionToken } from '@/lib/auth/session';
import { can } from '@/lib/auth/permissions';
import { NotFoundError, ValidationError } from '@/domain/errors';

let context: TestDatabase;

/**
 * The acting owner is created for real in beforeEach and its id used here.
 * Hard-coding an actor id collides with whichever user happens to be created
 * first, which silently trips the "cannot switch off your own account" guard.
 */
let OWNER_ACTOR: { id: number; username: string };

async function makeOwner(username = 'abena'): Promise<number> {
  return createUser(
    context.db,
    { username, displayName: 'Abena Mensah', password: 'owner-password-2026', role: 'OWNER' },
    null,
  );
}

async function makeStaff(username = 'ama'): Promise<number> {
  return createUser(
    context.db,
    {
      username,
      displayName: 'Ama Serwaa',
      password: 'staff-password-2026',
      role: 'STAFF',
      permissions: {
        sales: { canView: true, canCreate: true, canEdit: false, canVoid: false },
      },
    },
    null,
  );
}

beforeEach(async () => {
  context = createTestDatabase();
  // The owner doing the administering. Real, so its id is real.
  const id = await createUser(
    context.db,
    { username: 'kwame', displayName: 'Kwame Owusu', password: 'owner-password-2026', role: 'OWNER' },
    null,
  );
  OWNER_ACTOR = { id, username: 'kwame' };
});

afterEach(() => {
  context.cleanup();
});

describe('protecting the shop from locking itself out', () => {
  it('refuses to switch off the only owner', async () => {
    await makeStaff();

    // Attempted by someone else, so the self-deactivation rule is not what bites.
    expect(() =>
      setUserActive(context.db, OWNER_ACTOR.id, false, { id: 999, username: 'someone' }),
    ).toThrow(/only active owner/i);

    expect(getUser(context.db, OWNER_ACTOR.id).isActive).toBe(true);
  });

  it('refuses to demote the only owner', () => {
    expect(() =>
      updateUser(
        context.db,
        OWNER_ACTOR.id,
        { displayName: 'Kwame Owusu', role: 'STAFF' },
        OWNER_ACTOR,
      ),
    ).toThrow(/only owner/i);

    expect(getUser(context.db, OWNER_ACTOR.id).role).toBe('OWNER');
  });

  it('allows it once a SECOND owner exists', async () => {
    const second = await makeOwner();

    expect(() =>
      setUserActive(context.db, OWNER_ACTOR.id, false, { id: second, username: 'abena' }),
    ).not.toThrow();
    expect(getUser(context.db, OWNER_ACTOR.id).isActive).toBe(false);
  });

  it('refuses to let someone switch off their own account', async () => {
    await makeOwner(); // a second owner, so the last-owner rule is not what bites

    expect(() => setUserActive(context.db, OWNER_ACTOR.id, false, OWNER_ACTOR)).toThrow(
      /your own account/i,
    );
  });

  it('never offers a way to delete a user', async () => {
    const staffId = await makeStaff();
    setUserActive(context.db, staffId, false, OWNER_ACTOR);

    // Switched off, but the row survives so their history stays intact.
    expect(context.db.select().from(users).where(eq(users.id, staffId)).get()).toBeDefined();
    expect(getUser(context.db, staffId).isActive).toBe(false);
  });
});

describe('changing what someone can do', () => {
  it('replaces the permission set and signs them out', async () => {
    const staffId = await makeStaff();

    const session = await login(context.db, {
      username: 'ama',
      password: 'staff-password-2026',
    });
    if (!session.ok) throw new Error('login failed');
    expect(validateSessionToken(context.db, session.token)).not.toBeNull();

    setUserPermissions(
      context.db,
      staffId,
      {
        sales: { canView: true, canCreate: true, canEdit: true, canVoid: true },
        reports: { canView: true, canCreate: false, canEdit: false, canVoid: false },
      },
      OWNER_ACTOR,
    );

    // Old rights cannot keep running in an open session.
    expect(validateSessionToken(context.db, session.token)).toBeNull();

    const permissions = getUserPermissions(context.db, staffId);
    expect(permissions['sales']?.canVoid).toBe(true);
    expect(permissions['reports']?.canView).toBe(true);
    // The previous set was replaced, not merged.
    expect(Object.keys(permissions)).toHaveLength(2);
  });

  it('drops rows that grant nothing', async () => {
    const staffId = await makeStaff();

    setUserPermissions(
      context.db,
      staffId,
      {
        sales: { canView: true, canCreate: false, canEdit: false, canVoid: false },
        settings: { canView: false, canCreate: false, canEdit: false, canVoid: false },
      },
      OWNER_ACTOR,
    );

    const rows = context.db
      .select()
      .from(userPermissions)
      .where(eq(userPermissions.userId, staffId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.module).toBe('sales');
  });

  it('refuses to set permissions on an owner, who already has everything', async () => {
    const ownerId = await makeOwner();
    expect(() =>
      setUserPermissions(
        context.db,
        ownerId,
        { sales: { canView: true, canCreate: false, canEdit: false, canVoid: false } },
        OWNER_ACTOR,
      ),
    ).toThrow(/already has full access/i);
  });

  it('clears permission rows when someone is promoted to owner', async () => {
    const staffId = await makeStaff();
    expect(
      context.db.select().from(userPermissions).where(eq(userPermissions.userId, staffId)).all()
        .length,
    ).toBeGreaterThan(0);

    updateUser(context.db, staffId, { displayName: 'Ama Serwaa', role: 'OWNER' }, OWNER_ACTOR);

    expect(
      context.db.select().from(userPermissions).where(eq(userPermissions.userId, staffId)).all(),
    ).toHaveLength(0);

    // And they now pass every permission check.
    const promoted = { role: 'OWNER' as const, permissions: {} };
    expect(can(promoted, 'settings', 'edit')).toBe(true);
  });

  it('signs them out when their role changes', async () => {
    const staffId = await makeStaff();
    const session = await login(context.db, {
      username: 'ama',
      password: 'staff-password-2026',
    });
    if (!session.ok) throw new Error('login failed');

    updateUser(context.db, staffId, { displayName: 'Ama Serwaa', role: 'OWNER' }, OWNER_ACTOR);
    expect(validateSessionToken(context.db, session.token)).toBeNull();
  });
});

describe('passwords', () => {
  it('an owner reset forces the person to choose their own', async () => {
    const staffId = await makeStaff();
    await resetUserPassword(context.db, staffId, 'temporary-password-1', OWNER_ACTOR);

    const result = await login(context.db, {
      username: 'ama',
      password: 'temporary-password-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The app shell uses this to force a change before anything else.
    expect(result.mustChangePassword).toBe(true);
  });

  it('a reset clears any lockout and ends open sessions', async () => {
    const staffId = await makeStaff();
    const session = await login(context.db, {
      username: 'ama',
      password: 'staff-password-2026',
    });
    if (!session.ok) throw new Error('login failed');

    for (let attempt = 0; attempt < MAX_FAILED_LOGINS; attempt++) {
      await login(context.db, { username: 'ama', password: 'wrong' });
    }
    expect(getUser(context.db, staffId).lockedUntil).not.toBeNull();

    await resetUserPassword(context.db, staffId, 'temporary-password-1', OWNER_ACTOR);

    expect(getUser(context.db, staffId).lockedUntil).toBeNull();
    expect(validateSessionToken(context.db, session.token)).toBeNull();
  });

  it('changing your own password requires the current one', async () => {
    const staffId = await makeStaff();

    await expect(
      changeOwnPassword(context.db, staffId, 'not-the-right-one', 'a-new-password-2026'),
    ).rejects.toThrow(/current password is not correct/i);

    // The old password still works, so nothing changed.
    expect((await login(context.db, { username: 'ama', password: 'staff-password-2026' })).ok).toBe(
      true,
    );
  });

  it('refuses reusing the same password', async () => {
    const staffId = await makeStaff();
    await expect(
      changeOwnPassword(context.db, staffId, 'staff-password-2026', 'staff-password-2026'),
    ).rejects.toThrow(/different from the current one/i);
  });

  it('a successful self-change clears the must-change flag and ends sessions', async () => {
    const staffId = await makeStaff();
    await resetUserPassword(context.db, staffId, 'temporary-password-1', OWNER_ACTOR);

    const session = await login(context.db, {
      username: 'ama',
      password: 'temporary-password-1',
    });
    if (!session.ok) throw new Error('login failed');

    await changeOwnPassword(context.db, staffId, 'temporary-password-1', 'chosen-by-me-2026');

    expect(getUser(context.db, staffId).mustChangePassword).toBe(false);
    expect(context.db.select().from(sessions).where(eq(sessions.userId, staffId)).all()).toHaveLength(
      0,
    );

    const after = await login(context.db, { username: 'ama', password: 'chosen-by-me-2026' });
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.mustChangePassword).toBe(false);
  });

  it('unlocking releases a lockout early', async () => {
    const staffId = await makeStaff();
    for (let attempt = 0; attempt < MAX_FAILED_LOGINS; attempt++) {
      await login(context.db, { username: 'ama', password: 'wrong' });
    }
    expect((await login(context.db, { username: 'ama', password: 'staff-password-2026' })).ok).toBe(
      false,
    );

    unlockUser(context.db, staffId, OWNER_ACTOR);

    expect((await login(context.db, { username: 'ama', password: 'staff-password-2026' })).ok).toBe(
      true,
    );
  });
});

describe('till PIN', () => {
  it('signs in with a PIN', async () => {
    const staffId = await makeStaff();
    await setUserPin(context.db, staffId, '8351', OWNER_ACTOR);

    const result = await loginWithPin(context.db, { username: 'ama', pin: '8351' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.username).toBe('ama');
    expect(validateSessionToken(context.db, result.token)).not.toBeNull();
  });

  it('refuses a wrong PIN, and refuses when no PIN is set', async () => {
    const staffId = await makeStaff();

    // No PIN yet — must not be distinguishable from a wrong one.
    const noPin = await loginWithPin(context.db, { username: 'ama', pin: '8351' });
    expect(noPin.ok).toBe(false);
    if (!noPin.ok) expect(noPin.reason).toBe('INVALID_CREDENTIALS');

    await setUserPin(context.db, staffId, '8351', OWNER_ACTOR);
    const wrong = await loginWithPin(context.db, { username: 'ama', pin: '9999' });
    expect(wrong.ok).toBe(false);
  });

  it('locks the account after repeated wrong PINs, exactly like a password', async () => {
    const staffId = await makeStaff();
    await setUserPin(context.db, staffId, '8351', OWNER_ACTOR);

    for (let attempt = 0; attempt < MAX_FAILED_LOGINS; attempt++) {
      await loginWithPin(context.db, { username: 'ama', pin: '0000' });
    }

    const locked = await loginWithPin(context.db, { username: 'ama', pin: '8351' });
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.reason).toBe('ACCOUNT_LOCKED');

    // And the password path is locked too — it is one account, one lockout.
    const byPassword = await login(context.db, {
      username: 'ama',
      password: 'staff-password-2026',
    });
    expect(byPassword.ok).toBe(false);
  });

  it('rejects a weak PIN and can remove one', async () => {
    const staffId = await makeStaff();
    await expect(setUserPin(context.db, staffId, '1234', OWNER_ACTOR)).rejects.toThrow(
      ValidationError,
    );
    await expect(setUserPin(context.db, staffId, '1111', OWNER_ACTOR)).rejects.toThrow(
      ValidationError,
    );

    await setUserPin(context.db, staffId, '8351', OWNER_ACTOR);
    expect(getUser(context.db, staffId).hasPin).toBe(true);

    await setUserPin(context.db, staffId, null, OWNER_ACTOR);
    expect(getUser(context.db, staffId).hasPin).toBe(false);
  });

  it('a switched-off account cannot sign in with a PIN either', async () => {
    const staffId = await makeStaff();
    await makeOwner();
    await setUserPin(context.db, staffId, '8351', OWNER_ACTOR);
    setUserActive(context.db, staffId, false, OWNER_ACTOR);

    const result = await loginWithPin(context.db, { username: 'ama', pin: '8351' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ACCOUNT_INACTIVE');
  });
});

describe('the audit log', () => {
  it('records every administrative action against the person who did it', async () => {
    const staffId = await makeStaff();

    setUserPermissions(
      context.db,
      staffId,
      { reports: { canView: true, canCreate: false, canEdit: false, canVoid: false } },
      OWNER_ACTOR,
    );
    await resetUserPassword(context.db, staffId, 'temporary-password-1', OWNER_ACTOR);
    setUserActive(context.db, staffId, false, OWNER_ACTOR);

    const entries = listAuditLogs(context.db, { entityType: 'user' });
    const actions = entries.map((entry) => entry.action);

    expect(actions).toContain('CREATE');
    expect(actions).toContain('PERMISSION_CHANGE');
    expect(actions).toContain('PASSWORD_CHANGE');
    expect(actions).toContain('ARCHIVE');
    expect(entries.every((entry) => entry.summary.length > 0)).toBe(true);
  });

  it('never records a password or a PIN', async () => {
    const staffId = await makeStaff();
    await resetUserPassword(context.db, staffId, 'super-secret-value-99', OWNER_ACTOR);
    await setUserPin(context.db, staffId, '8351', OWNER_ACTOR);
    await login(context.db, { username: 'ama', password: 'another-secret-attempt' });

    const everything = JSON.stringify(context.db.select().from(auditLogs).all());
    expect(everything).not.toContain('super-secret-value-99');
    expect(everything).not.toContain('another-secret-attempt');
    expect(everything).not.toContain('8351');
  });

  it('filters by person, action, kind and free text', async () => {
    const staffId = await makeStaff();
    await makeOwner();
    setUserActive(context.db, staffId, false, OWNER_ACTOR);

    expect(listAuditLogs(context.db, { action: 'ARCHIVE' }).length).toBeGreaterThan(0);
    expect(listAuditLogs(context.db, { entityType: 'user' }).length).toBeGreaterThan(0);
    expect(listAuditLogs(context.db, { search: 'switched off' }).length).toBeGreaterThan(0);
    expect(listAuditLogs(context.db, { search: 'nothing matches this' })).toHaveLength(0);

    // The count must agree with the rows for pagination to be honest.
    const query = { entityType: 'user' } as const;
    expect(countAuditLogs(context.db, query)).toBe(listAuditLogs(context.db, { ...query, limit: 500 }).length);
  });

  it('offers the entity types actually present', async () => {
    await makeStaff();
    const types = listAuditEntityTypes(context.db);
    expect(types).toContain('user');
    expect(new Set(types).size).toBe(types.length);
  });

  it('exposes no way to change or delete a record', () => {
    // The service module deliberately has no update/delete function. This test
    // documents that as an intended property, so adding one is a conscious act
    // rather than something that slips in.
    const names = Object.keys(auditService);
    expect(names.some((name) => /delete|remove|update|purge/i.test(name))).toBe(false);
  });
});

describe('listing people', () => {
  it('summarises each account', async () => {
    await makeOwner();
    const staffId = await makeStaff();
    await setUserPin(context.db, staffId, '8351', OWNER_ACTOR);

    const all = listUsers(context.db);
    const owner = all.find((user) => user.username === 'kwame');
    const staff = all.find((user) => user.username === 'ama');

    expect(owner?.role).toBe('OWNER');
    // An owner is not subject to the permission table, so they see everything.
    expect(owner?.moduleCount).toBeGreaterThan(10);

    expect(staff?.hasPin).toBe(true);
    expect(staff?.moduleCount).toBe(1);
    expect(staff?.lastLoginAt).toBeNull();
  });

  it('throws for an unknown user rather than returning nothing', () => {
    expect(() => getUser(context.db, 999_999)).toThrow(NotFoundError);
  });
});
