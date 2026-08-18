'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth/current-user';
import { THEME_COOKIE, isTheme } from '@/lib/theme';

/**
 * Choosing light, dark, or whatever the device is set to.
 *
 * Requires a session but no permission, and is not audited. How bright the
 * screen is at six in the morning is not a permission — requiring one would
 * leave a till operator squinting. The session check is simply because the
 * control only exists behind sign-in, so there is no reason to leave the
 * endpoint open.
 *
 * The cookie itself is not tied to the user, so the preference survives signing
 * out on a shared counter machine.
 */
export async function setThemeAction(formData: FormData): Promise<void> {
  await requireUser();

  const choice = formData.get('theme');
  // Anything unrecognised falls back to following the device rather than
  // writing junk into a cookie that is read on every request.
  const theme = isTheme(choice) ? choice : 'system';

  const store = await cookies();

  if (theme === 'system') {
    // No cookie at all is what "follow the device" means.
    store.delete(THEME_COOKIE);
  } else {
    store.set(THEME_COOKIE, theme, {
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
      // A year: a preference about a screen does not need re-stating monthly.
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  // The attribute lives on <html>, which every page shares.
  revalidatePath('/', 'layout');
}
