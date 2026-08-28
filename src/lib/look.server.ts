import 'server-only';

import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { businessSettings } from '@/db/schema';
import { isLook, type Look } from './look';

/**
 * Reading the shop's look.
 *
 * Read on the server and written onto `<html>` before the page is sent, so the
 * right palette is there from the first paint rather than swapped in after —
 * the same approach `theme.server.ts` takes, and for the same reason: no
 * JavaScript, and no flash of the wrong colours.
 *
 * Everything falls back to 'default'. This runs in the ROOT layout, which also
 * wraps the sign-in and first-run setup screens, and on a brand new install
 * there is no settings row to read yet. A missing row, a database that will not
 * open, or a value written by hand into the file must all leave the app looking
 * the way it always has rather than failing to render at all.
 */
export function getLook(): Look {
  try {
    const stored = db
      .select({ look: businessSettings.look })
      .from(businessSettings)
      .where(eq(businessSettings.id, 1))
      .get()?.look;

    return isLook(stored) ? stored : 'default';
  } catch {
    return 'default';
  }
}
