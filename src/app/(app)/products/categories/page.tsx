import type { Metadata } from 'next';
import Link from 'next/link';

import { db } from '@/db/client';
import { requirePageAccess } from '@/lib/auth/current-user';
import { can } from '@/lib/auth/permissions';
import { listCategories } from '@/services/catalog.service';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page';
import { EmptyRow, TableWrap, TD, TH, THead, TR } from '@/components/ui/table';
import { NewCategoryForm } from './new-category-form';

export const metadata: Metadata = { title: 'Categories' };
export const dynamic = 'force-dynamic';

export default async function CategoriesPage() {
  const user = await requirePageAccess('products', 'view');
  const categories = listCategories(db, true);
  const canCreate = can(user, 'products', 'create');

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Categories"
        description="Group your products however suits the shop. Nothing here is fixed."
        actions={
          <Link href="/products">
            <Button variant="secondary" size="sm">
              Back to products
            </Button>
          </Link>
        }
      />

      {canCreate && <NewCategoryForm />}

      <TableWrap className="mt-6">
        <THead>
          <TH>Category</TH>
          <TH numeric>Products</TH>
          <TH>Status</TH>
        </THead>
        <tbody>
          {categories.length === 0 && (
            <EmptyRow colSpan={3}>
              No categories yet. Drinks, Food, Household — whatever fits your shop.
            </EmptyRow>
          )}
          {categories.map((category) => (
            <TR key={category.id}>
              <TD>
                <div className="font-medium text-content">{category.name}</div>
                {category.description && (
                  <div className="mt-0.5 text-xs text-content-subtle">{category.description}</div>
                )}
              </TD>
              <TD numeric>{category.productCount}</TD>
              <TD>
                {category.isActive ? (
                  <Badge tone="success">Active</Badge>
                ) : (
                  <Badge tone="neutral">Archived</Badge>
                )}
              </TD>
            </TR>
          ))}
        </tbody>
      </TableWrap>

      <p className="mt-4 text-xs text-content-subtle">
        Categories are archived rather than deleted, so products keep their history and old reports
        stay readable.
      </p>
    </div>
  );
}
