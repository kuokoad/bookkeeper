import 'server-only';

import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { db } from '@/db/client';
import { ForbiddenError, UnauthenticatedError } from '@/domain/errors';
import type { PermissionModule } from '@/db/schema/users';
import { can, type PermissionAction, type Principal } from './permissions';
import { SESSION_COOKIE_NAME, validateSessionToken, type SessionContext } from './session';

/**
 * Request-scoped access to the signed-in user.
 *
 * `cache()` deduplicates the lookup within a single request, so a layout, a page
 * and three server actions all share one session validation instead of five.
 */
export const getSessionContext = cache(async (): Promise<SessionContext | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return validateSessionToken(db, token);
});

export async function getCurrentUser(): Promise<Principal | null> {
  const context = await getSessionContext();
  return context?.principal ?? null;
}

/** Throws when not signed in. Use in any server action that changes data. */
export async function requireUser(): Promise<Principal> {
  const principal = await getCurrentUser();
  if (!principal) throw new UnauthenticatedError();
  return principal;
}

/**
 * The gate every mutating server action passes through.
 *
 * Authorisation is checked here on the server, from the session cookie — never
 * from a user id, role or permission flag sent by the browser.
 */
export async function requirePermission(
  module: PermissionModule,
  action: PermissionAction,
): Promise<Principal> {
  const principal = await requireUser();
  if (!can(principal, module, action)) {
    throw new ForbiddenError(`${action} on ${module}`);
  }
  return principal;
}

/**
 * The gate every PAGE passes through.
 *
 * Same authorisation decision as `requirePermission`, different response. A
 * thrown error is right for an action or an API route, whose caller is code;
 * for a page, whose caller is a person who typed an address, it renders the
 * server-error page — which tells them nothing and looks like a broken shop.
 * So a refused page sends them somewhere that explains instead.
 *
 * Not signed in at all is a different matter: that goes to the sign-in screen.
 */
export async function requirePageAccess(
  module: PermissionModule,
  action: PermissionAction,
): Promise<Principal> {
  const principal = await getCurrentUser();
  if (!principal) redirect('/login');
  if (!can(principal, module, action)) {
    redirect(`/no-access?area=${encodeURIComponent(module)}`);
  }
  return principal;
}

/** Best-effort client details for the audit log. */
export async function getRequestMetadata(): Promise<{
  ipAddress: string | undefined;
  userAgent: string | undefined;
}> {
  const headerList = await headers();
  const forwarded = headerList.get('x-forwarded-for');
  const ipAddress = forwarded?.split(',')[0]?.trim() ?? headerList.get('x-real-ip') ?? undefined;
  return {
    ipAddress: ipAddress ?? undefined,
    userAgent: headerList.get('user-agent') ?? undefined,
  };
}
