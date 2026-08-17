'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { db } from '@/db/client';
import { requirePermission, requireUser } from '@/lib/auth/current-user';
import { createUser } from '@/services/auth.service';
import {
  changeOwnPassword,
  resetUserPassword,
  setUserActive,
  setUserPermissions,
  setUserPin,
  unlockUser,
  updateUser,
} from '@/services/user.service';
import { PERMISSION_MODULES, USER_ROLES } from '@/db/schema/users';
import type { PermissionMap } from '@/lib/auth/permissions';
import { defaultStaffPermissions } from '@/lib/auth/permissions';
import { isDomainError } from '@/domain/errors';
import type { FormState } from './auth.actions';

/**
 * User management.
 *
 * Every action here requires the `users` permission, which staff never hold by
 * default — an account that can grant itself more rights is not a permission
 * system. The one exception is changing your OWN password, which any signed-in
 * person may do.
 */

function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  return fieldErrors;
}

/** Read the permission matrix out of the posted checkboxes. */
function readPermissions(formData: FormData): PermissionMap {
  const map: PermissionMap = {};
  for (const moduleName of PERMISSION_MODULES) {
    const canView = formData.get(`perm:${moduleName}:view`) === 'on';
    const canCreate = formData.get(`perm:${moduleName}:create`) === 'on';
    const canEdit = formData.get(`perm:${moduleName}:edit`) === 'on';
    const canVoid = formData.get(`perm:${moduleName}:void`) === 'on';
    if (!canView && !canCreate && !canEdit && !canVoid) continue;
    map[moduleName] = { canView, canCreate, canEdit, canVoid };
  }
  return map;
}

const createSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, 'Username must be at least 3 characters.')
    .max(40)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Use only letters, numbers, dots, dashes or underscores.'),
  displayName: z.string().trim().min(2, 'Enter the person’s name.').max(80),
  password: z.string().min(8, 'Password must be at least 8 characters.').max(200),
  role: z.enum(USER_ROLES),
  pin: z.string().trim().optional(),
});

export async function createUserAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('users', 'create');

  const parsed = createSchema.safeParse({
    username: formData.get('username'),
    displayName: formData.get('displayName'),
    password: formData.get('password'),
    role: formData.get('role'),
    pin: formData.get('pin') ?? undefined,
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  const usePreset = formData.get('usePreset') === 'on';
  const permissions =
    parsed.data.role === 'OWNER'
      ? undefined
      : usePreset
        ? defaultStaffPermissions()
        : readPermissions(formData);

  let userId: number;
  try {
    userId = await createUser(
      db,
      {
        username: parsed.data.username,
        displayName: parsed.data.displayName,
        password: parsed.data.password,
        role: parsed.data.role,
        ...(parsed.data.pin ? { pin: parsed.data.pin } : {}),
        ...(permissions ? { permissions } : {}),
        // They set their own password on first sign-in, so the owner does not
        // keep knowing a working credential for someone else's account.
        mustChangePassword: true,
      },
      { id: actor.id, username: actor.username },
    );
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/users');
  redirect(`/users/${userId}?created=1`);
}

const updateSchema = z.object({
  displayName: z.string().trim().min(2, 'Enter the person’s name.').max(80),
  role: z.enum(USER_ROLES),
});

export async function updateUserAction(
  userId: number,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('users', 'edit');

  const parsed = updateSchema.safeParse({
    displayName: formData.get('displayName'),
    role: formData.get('role'),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  try {
    updateUser(db, userId, parsed.data, { id: actor.id, username: actor.username });
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/users');
  revalidatePath(`/users/${userId}`);
  redirect(`/users/${userId}?updated=1`);
}

export async function setUserPermissionsAction(
  userId: number,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('users', 'edit');

  try {
    setUserPermissions(db, userId, readPermissions(formData), {
      id: actor.id,
      username: actor.username,
    });
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath('/users');
  revalidatePath(`/users/${userId}`);
  redirect(`/users/${userId}?permissions=1`);
}

export async function setUserActiveAction(userId: number, isActive: boolean): Promise<void> {
  const actor = await requirePermission('users', 'edit');
  setUserActive(db, userId, isActive, { id: actor.id, username: actor.username });
  revalidatePath('/users');
  revalidatePath(`/users/${userId}`);
}

export async function unlockUserAction(userId: number): Promise<void> {
  const actor = await requirePermission('users', 'edit');
  unlockUser(db, userId, { id: actor.id, username: actor.username });
  revalidatePath('/users');
  revalidatePath(`/users/${userId}`);
}

export async function resetPasswordAction(
  userId: number,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('users', 'edit');

  const password = String(formData.get('password') ?? '');
  if (password.length < 8) {
    return { fieldErrors: { password: 'Password must be at least 8 characters.' } };
  }

  try {
    await resetUserPassword(db, userId, password, { id: actor.id, username: actor.username });
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  revalidatePath(`/users/${userId}`);
  redirect(`/users/${userId}?reset=1`);
}

export async function setPinAction(
  userId: number,
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requirePermission('users', 'edit');

  const raw = String(formData.get('pin') ?? '').trim();
  const pin = raw === '' ? null : raw;

  try {
    await setUserPin(db, userId, pin, { id: actor.id, username: actor.username });
  } catch (error) {
    if (isDomainError(error)) return { fieldErrors: { pin: error.userMessage } };
    throw error;
  }

  revalidatePath(`/users/${userId}`);
  redirect(`/users/${userId}?pin=1`);
}

// --- self service ---------------------------------------------------------

const ownPasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password.'),
    newPassword: z.string().min(8, 'Password must be at least 8 characters.').max(200),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'The two passwords do not match.',
    path: ['confirmPassword'],
  });

/** Anyone signed in may change their own password. */
export async function changeOwnPasswordAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const actor = await requireUser();

  const parsed = ownPasswordSchema.safeParse({
    currentPassword: formData.get('currentPassword'),
    newPassword: formData.get('newPassword'),
    confirmPassword: formData.get('confirmPassword'),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error) };

  try {
    await changeOwnPassword(db, actor.id, parsed.data.currentPassword, parsed.data.newPassword);
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    throw error;
  }

  // Every session was ended, including this one, so they sign in afresh.
  redirect('/login?passwordChanged=1');
}
