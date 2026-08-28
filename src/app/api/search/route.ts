import { NextRequest } from 'next/server';

import { db } from '@/db/client';
import { getCurrentUser } from '@/lib/auth/current-user';
import { SEARCH_THROTTLE, throttleOrNull } from '@/lib/http-throttle';
import { search } from '@/services/search.service';

/**
 * Search results as JSON, for the box in the top bar.
 *
 * The SAME `search()` the /search page calls, on purpose. The dropdown and the
 * full page must never disagree about what the shop contains or about who may
 * see it — one query, one set of permission rules, two ways of showing them.
 *
 * Signed in is the only requirement, matching the page: the permission work
 * happens per record type inside the service, so a till operator looking up a
 * product gets the product and nothing they are not entitled to. Guarding this
 * on a module would make the box in their own top bar always refuse.
 *
 * A 401 rather than a redirect. This is called by fetch, and a redirect to the
 * sign-in page would arrive as an HTML body the caller cannot use — it would
 * look like a search returning nothing rather than like a session that ended.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const throttled = throttleOrNull(db, `search:${user.id}`, SEARCH_THROTTLE);
  if (throttled) return throttled;

  const query = request.nextUrl.searchParams.get('q') ?? '';
  const results = search(db, query, user);

  return Response.json(results, {
    // Two people at one counter are two different sets of permissions, and a
    // shop's records change all day. Neither the browser nor anything between
    // may hold on to an answer.
    headers: { 'Cache-Control': 'no-store, private' },
  });
}
