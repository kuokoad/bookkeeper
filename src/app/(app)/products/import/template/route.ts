import { requirePermission } from '@/lib/auth/current-user';
import { TEMPLATE_HEADINGS } from '@/services/product-import.service';
import { csvResponse, toCsv } from '@/lib/csv';
import { isDomainError } from '@/domain/errors';

export const dynamic = 'force-dynamic';

/** The product import template: the heading row only, so no example row is imported by mistake. */
export async function GET(): Promise<Response> {
  try {
    await requirePermission('products', 'create');
  } catch (error) {
    if (isDomainError(error) && error.code === 'UNAUTHENTICATED') {
      return new Response('Please sign in.', { status: 401 });
    }
    if (isDomainError(error) && error.code === 'FORBIDDEN') {
      return new Response('You do not have permission to import products.', { status: 403 });
    }
    throw error;
  }
  return csvResponse('bookkeeper_product-import-template.csv', toCsv(TEMPLATE_HEADINGS, []));
}
