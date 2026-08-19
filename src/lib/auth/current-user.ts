import 'server-only';

import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { users } from '@/db/schema';
import { env } from '@/lib/env';
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
 * Somebody handed a starting password must choose their own before working.
 *
 * The app shell redirects them to the password page, which stops them
 * NAVIGATING anywhere else. It does not stop them ACTING: a server action is
 * its own endpoint and no layout runs on the way in, so a form left open in
 * another tab — or a request made by hand — would still record a sale under an
 * account whose password the owner still knows. The point of forcing the change
 * is that only one person can act as that account, and that is not true until
 * this is checked where the acting happens.
 *
 * Deliberately in `requirePermission` rather than `requireUser`: changing your
 * own password needs `requireUser`, and gating it here would leave the person
 * with no way out of the requirement.
 */
function assertPasswordChosen(principal: Principal): void {
  const row = db
    .select({ mustChangePassword: users.mustChangePassword })
    .from(users)
    .where(eq(users.id, principal.id))
    .get();

  if (row?.mustChangePassword === true) {
    throw new ForbiddenError('act before choosing your own password');
  }
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
  assertPasswordChosen(principal);
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

/**
 * Best-effort client details for the audit log.
 *
 * `X-Forwarded-For` and `X-Real-IP` are only read when a proxy is configured
 * and declared trustworthy. The shop normally runs the app directly, where
 * those headers are simply whatever the caller typed — recording a forged
 * address in the audit trail would make the log worse than leaving it blank,
 * because a blank is honestly unknown while a forgery reads as evidence.
 *
 * `throttleKey` is separated out for the same reason and stated explicitly: it
 * is what the sign-in rate limit counts against. See `clientThrottleKey`.
 */
export async function getRequestMetadata(): Promise<{
  ipAddress: string | undefined;
  userAgent: string | undefined;
}> {
  const headerList = await headers();
  return {
    ipAddress: env.TRUST_PROXY_HEADERS ? forwardedAddress(headerList) : undefined,
    userAgent: headerList.get('user-agent') ?? undefined,
  };
}

function forwardedAddress(headerList: Headers): string | undefined {
  const forwarded = headerList.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  return headerList.get('x-real-ip')?.trim() || undefined;
}

/**
 * What the sign-in rate limit counts against.
 *
 * Behind a trusted proxy this is the caller's address, so one misbehaving
 * visitor cannot throttle everybody else. Without one there is no address that
 * can be believed — Next.js does not surface the socket's own — so every
 * attempt counts against a SINGLE shared bucket.
 *
 * That is deliberate. A shared bucket can be exhausted by one persistent
 * guesser, which is a nuisance on a shop's own network and recoverable by
 * waiting; per-address buckets keyed on a header the caller writes are not a
 * limit at all, because a fresh value on each attempt gets a fresh allowance.
 * A limit that can be shrugged off is worse than an inconvenient one, and the
 * per-account lockout still stands behind it either way.
 */
export async function clientThrottleKey(prefix: string): Promise<string> {
  if (!env.TRUST_PROXY_HEADERS) return `${prefix}:shared`;
  const headerList = await headers();
  return `${prefix}:${forwardedAddress(headerList) ?? 'unknown'}`;
}
