import 'server-only';

import { cookies } from 'next/headers';

import { THEME_COOKIE, isTheme, type Theme } from './theme';

/**
 * Reading the stored preference.
 *
 * Read on the server and written onto `<html>` before the page is sent, so the
 * right palette is there from the first paint rather than swapped in after —
 * there is no JavaScript involved at all.
 */
export async function getTheme(): Promise<Theme> {
  const stored = (await cookies()).get(THEME_COOKIE)?.value;
  return isTheme(stored) ? stored : 'system';
}
