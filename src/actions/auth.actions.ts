'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { db } from '@/db/client';
import { login, loginWithPin, createUser, needsInitialSetup } from '@/services/auth.service';
import { writeAudit } from '@/services/audit.service';
import {
  SESSION_ABSOLUTE_MAX_MS,
  SESSION_COOKIE_NAME,
  invalidateSessionToken,
} from '@/lib/auth/session';
import {
  clientThrottleKey,
  getRequestMetadata,
  getSessionContext,
} from '@/lib/auth/current-user';
import { rateLimit, resetRateLimit } from '@/lib/rate-limit';
import { isDomainError } from '@/domain/errors';
import { env, isProduction } from '@/lib/env';

/**
 * Authentication server actions.
 *
 * Every branch returns an explicit success or error state — nothing fails
 * silently, and no internal detail reaches the browser.
 */

export interface FormState {
  error?: string;
  fieldErrors?: Record<string, string>;
  /**
   * Confirmation for forms that stay on the page instead of redirecting. A save
   * that leaves the screen unchanged is indistinguishable from one that failed
   * silently, which is the thing this application must never do.
   */
  success?: string;
}

const LOGIN_ATTEMPT_LIMIT = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

const loginSchema = z.object({
  username: z.string().trim().min(1, 'Enter your username.').max(40),
  password: z.string().min(1, 'Enter your password.').max(200),
});

/**
 * The cookie carries the token; the database decides whether it is still good.
 *
 * It is deliberately given the session's ABSOLUTE ceiling rather than its
 * current expiry. The server slides that expiry forward while somebody keeps
 * working, and a cookie stamped with the original deadline would be discarded
 * by the browser on that date regardless — the server would have kept the
 * session alive and the browser would have thrown its half away, signing the
 * person out mid-week for no visible reason. Cookies cannot be re-issued during
 * an ordinary page render in the App Router, so the fix is to stop the cookie
 * from being the thing that expires.
 *
 * Nothing is lost by the longer cookie: an expired or revoked session is
 * refused by `validateSessionToken` on the strength of the database row, and a
 * cookie whose row has gone is simply an unrecognised string.
 */
function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    // The shop runs over plain HTTP on its own LAN, so `secure` would stop the
    // cookie being sent at all. Set COOKIE_SECURE=true if served over HTTPS.
    // Read through the validated environment, so `1` and `true` both work and a
    // misspelling is not silently treated as "off".
    secure: env.COOKIE_SECURE,
    maxAge: Math.floor(SESSION_ABSOLUTE_MAX_MS / 1000),
  };
}

export async function loginAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const parsed = loginSchema.safeParse({
    username: formData.get('username'),
    password: formData.get('password'),
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { fieldErrors };
  }

  const metadata = await getRequestMetadata();
  const throttleKey = await clientThrottleKey('login');
  const throttle = rateLimit(throttleKey, LOGIN_ATTEMPT_LIMIT, LOGIN_WINDOW_MS);

  if (!throttle.allowed) {
    const minutes = Math.ceil(throttle.retryAfterMs / 60_000);
    return { error: `Too many sign-in attempts. Please wait ${minutes} minute(s) and try again.` };
  }

  const result = await login(db, parsed.data, metadata);

  if (!result.ok) {
    // Deliberately uniform wording: a guesser must not learn whether the
    // username exists or the account is merely deactivated.
    if (result.reason === 'ACCOUNT_LOCKED') {
      const minutes = Math.max(
        1,
        Math.ceil(((result.lockedUntil?.getTime() ?? Date.now()) - Date.now()) / 60_000),
      );
      return {
        error: `This account is temporarily locked after too many failed attempts. Try again in ${minutes} minute(s).`,
      };
    }
    return { error: 'Incorrect username or password.' };
  }

  resetRateLimit(throttleKey);

  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, result.token, sessionCookieOptions());

  redirect('/dashboard');
}

const pinLoginSchema = z.object({
  username: z.string().trim().min(1, 'Enter your username.').max(40),
  pin: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, 'A till PIN is 4 to 8 digits.'),
});

/**
 * Signing in at the till with a short PIN.
 *
 * Intended for a shared counter machine where typing a full password in front
 * of a queue is impractical. It is a genuine credential, not a shortcut past
 * one: the PIN is hashed like a password, the account must already be active,
 * and it shares the same per-IP throttle and the same per-account lockout
 * counter as password sign-in — so a PIN cannot be used to get extra guesses.
 */
export async function pinLoginAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = pinLoginSchema.safeParse({
    username: formData.get('username'),
    pin: formData.get('pin'),
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { fieldErrors };
  }

  const metadata = await getRequestMetadata();
  // The SAME throttle key as password sign-in, deliberately: two doors into one
  // account must not mean twice the attempts.
  const throttleKey = await clientThrottleKey('login');
  const throttle = rateLimit(throttleKey, LOGIN_ATTEMPT_LIMIT, LOGIN_WINDOW_MS);

  if (!throttle.allowed) {
    const minutes = Math.ceil(throttle.retryAfterMs / 60_000);
    return { error: `Too many sign-in attempts. Please wait ${minutes} minute(s) and try again.` };
  }

  const result = await loginWithPin(db, parsed.data, metadata);

  if (!result.ok) {
    if (result.reason === 'ACCOUNT_LOCKED') {
      const minutes = Math.max(
        1,
        Math.ceil(((result.lockedUntil?.getTime() ?? Date.now()) - Date.now()) / 60_000),
      );
      return {
        error: `This account is temporarily locked after too many failed attempts. Try again in ${minutes} minute(s).`,
      };
    }
    // Uniform wording, so a guesser learns nothing about whether the username
    // exists or whether that person has a PIN at all.
    return { error: 'Incorrect username or PIN.' };
  }

  resetRateLimit(throttleKey);

  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, result.token, sessionCookieOptions());

  redirect('/dashboard');
}

export async function logoutAction(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  const context = await getSessionContext();

  if (token) {
    if (context) {
      writeAudit(db, {
        action: 'LOGOUT',
        entityType: 'user',
        entityId: context.principal.id,
        userId: context.principal.id,
        username: context.principal.username,
        summary: `${context.principal.displayName} signed out`,
      });
    }
    invalidateSessionToken(db, token);
  }

  store.delete(SESSION_COOKIE_NAME);
  redirect('/login');
}

// --- first run -------------------------------------------------------------

const setupSchema = z
  .object({
    businessName: z.string().trim().min(2, 'Enter your shop name.').max(120),
    displayName: z.string().trim().min(2, 'Enter your name.').max(80),
    username: z
      .string()
      .trim()
      .min(3, 'Username must be at least 3 characters.')
      .max(40)
      .regex(/^[a-zA-Z0-9._-]+$/, 'Use only letters, numbers, dots, dashes or underscores.'),
    password: z.string().min(8, 'Password must be at least 8 characters.').max(200),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'The two passwords do not match.',
    path: ['confirmPassword'],
  });

/**
 * Creates the owner account on first run.
 *
 * Guarded by `needsInitialSetup`: once any user exists this action refuses,
 * so the setup page can never be used to mint a second owner.
 */
export async function setupOwnerAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!needsInitialSetup(db)) {
    return { error: 'Setup has already been completed. Please sign in.' };
  }

  const parsed = setupSchema.safeParse({
    businessName: formData.get('businessName'),
    displayName: formData.get('displayName'),
    username: formData.get('username'),
    password: formData.get('password'),
    confirmPassword: formData.get('confirmPassword'),
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { fieldErrors };
  }

  const { businessName, displayName, username, password } = parsed.data;

  try {
    await createUser(db, { username, displayName, password, role: 'OWNER' });
  } catch (error) {
    if (isDomainError(error)) return { error: error.userMessage };
    if (!isProduction) throw error;
    return { error: 'Could not complete setup. Please try again.' };
  }

  const { businessSettings } = await import('@/db/schema');
  const { eq } = await import('drizzle-orm');
  db.update(businessSettings)
    .set({ businessName, setupCompletedAt: new Date(), updatedAt: new Date() })
    .where(eq(businessSettings.id, 1))
    .run();

  redirect('/login?setup=complete');
}
