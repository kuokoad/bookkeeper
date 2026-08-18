import { db } from '@/db/client';
import { getLogo } from '@/services/settings.service';

export const dynamic = 'force-dynamic';

/**
 * Serves the shop's logo.
 *
 * Deliberately NOT behind a session check: the logo appears on receipts, which
 * are printed and handed to customers, and a shop's own logo is not a secret.
 * Nothing else about the shop is exposed here.
 *
 * The `Content-Type` is the one read from the file's own bytes when it was
 * uploaded, never the one the browser announced — otherwise whoever uploaded
 * the file would get to choose how it is served. `nosniff` stops the browser
 * second-guessing that, which is what turns a mislabelled file into script.
 */
export async function GET(): Promise<Response> {
  const logo = getLogo(db);

  if (!logo) {
    return new Response('No logo has been set.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' },
    });
  }

  return new Response(new Uint8Array(logo.data), {
    headers: {
      'Content-Type': logo.mime,
      'Content-Length': String(logo.data.length),
      'X-Content-Type-Options': 'nosniff',
      // Never rendered as a page in its own right.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      // Revalidate rather than cache hard: a changed logo must show up at once.
      'Cache-Control': 'no-cache, must-revalidate',
      ...(logo.updatedAt ? { 'Last-Modified': logo.updatedAt.toUTCString() } : {}),
    },
  });
}
