import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '../helpers/test-db';
import { createUser } from '@/services/auth.service';
import { getUser, getUserPermissions, setUserPermissions, updateUser } from '@/services/user.service';

/**
 * Nobody may hand themselves more rights than they were given.
 *
 * The `users` module exists so an owner can delegate looking after staff
 * accounts — resetting a forgotten password, unlocking someone, switching a
 * leaver off. It must not be a route to becoming an owner, because an account
 * that can grant itself more rights is not a permission system.
 */

let context: TestDatabase;
let ownerId = 0;
let managerId = 0;

const OWNER = () => ({ id: ownerId, username: 'kwame' });
/** Staff trusted with the users module — "let Bob look after the team". */
const MANAGER = () => ({ id: managerId, username: 'bob' });

beforeEach(async () => {
  context = createTestDatabase();

  ownerId = await createUser(
    context.db,
    { username: 'kwame', displayName: 'Kwame Owusu', password: 'owner-password-2026', role: 'OWNER' },
    null,
  );
  managerId = await createUser(
    context.db,
    {
      username: 'bob',
      displayName: 'Bob Mensah',
      password: 'staff-password-2026',
      role: 'STAFF',
      permissions: { users: { canView: true, canCreate: true, canEdit: true, canVoid: false } },
    },
    OWNER(),
  );
});

afterEach(() => context.cleanup());

describe('promoting to owner', () => {
  it('REFUSES a staff member promoting themselves', () => {
    expect(() =>
      updateUser(context.db, managerId, { displayName: 'Bob Mensah', role: 'OWNER' }, MANAGER()),
    ).toThrow(/owner/i);

    expect(getUser(context.db, managerId).role).toBe('STAFF');
  });

  it('REFUSES a staff member promoting a colleague', async () => {
    const colleagueId = await createUser(
      context.db,
      { username: 'ama', displayName: 'Ama', password: 'staff-password-2026', role: 'STAFF' },
      OWNER(),
    );

    // Promoting a colleague then borrowing their account is the same hole with
    // one extra step.
    expect(() =>
      updateUser(context.db, colleagueId, { displayName: 'Ama', role: 'OWNER' }, MANAGER()),
    ).toThrow(/owner/i);

    expect(getUser(context.db, colleagueId).role).toBe('STAFF');
  });

  it('still lets a staff member rename someone, which changes no rights', () => {
    expect(() =>
      updateUser(context.db, ownerId, { displayName: 'Kwame O. Owusu', role: 'OWNER' }, MANAGER()),
    ).not.toThrow();

    expect(getUser(context.db, ownerId).displayName).toBe('Kwame O. Owusu');
  });

  it('allows an owner to promote someone', async () => {
    const staffId = await createUser(
      context.db,
      { username: 'ama', displayName: 'Ama', password: 'staff-password-2026', role: 'STAFF' },
      OWNER(),
    );

    updateUser(context.db, staffId, { displayName: 'Ama', role: 'OWNER' }, OWNER());
    expect(getUser(context.db, staffId).role).toBe('OWNER');
  });

  it('REFUSES anyone changing their OWN role, owner included', async () => {
    const secondOwner = await createUser(
      context.db,
      { username: 'abena', displayName: 'Abena', password: 'owner-password-2026', role: 'OWNER' },
      OWNER(),
    );

    // Not the last-owner rule: there are two. Changing your own role is simply
    // not something you do to yourself.
    expect(() =>
      updateUser(context.db, secondOwner, { displayName: 'Abena', role: 'STAFF' }, {
        id: secondOwner,
        username: 'abena',
      }),
    ).toThrow(/your own role/i);
  });
});

describe('creating accounts', () => {
  it('REFUSES a staff member minting a new owner', async () => {
    await expect(
      createUser(
        context.db,
        { username: 'mole', displayName: 'Mole', password: 'a-password-2026', role: 'OWNER' },
        MANAGER(),
      ),
    ).rejects.toThrow(/owner/i);
  });

  it('still lets a staff member with the right create ordinary staff', async () => {
    const id = await createUser(
      context.db,
      { username: 'newhire', displayName: 'New Hire', password: 'a-password-2026', role: 'STAFF' },
      MANAGER(),
    );
    expect(getUser(context.db, id).role).toBe('STAFF');
  });

  it('REFUSES granting a new account rights the creator does not hold', async () => {
    // Bob looks after the team. He has no access to the accounts, so he cannot
    // create a colleague who does and then sign in as them.
    await expect(
      createUser(
        context.db,
        {
          username: 'proxy',
          displayName: 'Proxy',
          password: 'a-password-2026',
          role: 'STAFF',
          permissions: { accounts: { canView: true, canCreate: true, canEdit: true, canVoid: true } },
        },
        MANAGER(),
      ),
    ).rejects.toThrow(/accounts/i);
  });

  it('lets the creator pass on rights they DO hold', async () => {
    const id = await createUser(
      context.db,
      {
        username: 'deputy',
        displayName: 'Deputy',
        password: 'a-password-2026',
        role: 'STAFF',
        // Bob holds users view/create/edit, so he may hand those on. Not void:
        // he does not have it.
        permissions: { users: { canView: true, canCreate: true, canEdit: false, canVoid: false } },
      },
      MANAGER(),
    );

    expect(getUserPermissions(context.db, id).users?.canCreate).toBe(true);
  });

  it('REFUSES passing on a level of a right the creator lacks', async () => {
    await expect(
      createUser(
        context.db,
        {
          username: 'voider',
          displayName: 'Voider',
          password: 'a-password-2026',
          role: 'STAFF',
          // Bob has users, but not the void flag on it.
          permissions: { users: { canView: true, canCreate: false, canEdit: false, canVoid: true } },
        },
        MANAGER(),
      ),
    ).rejects.toThrow(/users/i);
  });

  it('still allows the very first owner, created by nobody', async () => {
    // First run: there is no actor to be an owner yet.
    const fresh = createTestDatabase();
    try {
      const id = await createUser(
        fresh.db,
        { username: 'first', displayName: 'First Owner', password: 'a-password-2026', role: 'OWNER' },
        null,
      );
      expect(id).toBeGreaterThan(0);
    } finally {
      fresh.cleanup();
    }
  });
});

describe('permissions', () => {
  it('REFUSES a staff member rewriting their own permissions', () => {
    expect(() =>
      setUserPermissions(
        context.db,
        managerId,
        { accounts: { canView: true, canCreate: true, canEdit: true, canVoid: true } },
        MANAGER(),
      ),
    ).toThrow(/own permissions|owner/i);
  });

  it('REFUSES a staff member granting rights to anyone else', async () => {
    const staffId = await createUser(
      context.db,
      { username: 'ama', displayName: 'Ama', password: 'staff-password-2026', role: 'STAFF' },
      OWNER(),
    );

    // Granting a colleague the keys is escalation with one extra step.
    expect(() =>
      setUserPermissions(
        context.db,
        staffId,
        { accounts: { canView: true, canCreate: true, canEdit: true, canVoid: true } },
        MANAGER(),
      ),
    ).toThrow(/owner/i);
  });

  it('allows an owner to set permissions', async () => {
    const staffId = await createUser(
      context.db,
      { username: 'ama', displayName: 'Ama', password: 'staff-password-2026', role: 'STAFF' },
      OWNER(),
    );

    expect(() =>
      setUserPermissions(
        context.db,
        staffId,
        { sales: { canView: true, canCreate: true, canEdit: false, canVoid: false } },
        OWNER(),
      ),
    ).not.toThrow();
  });
});
