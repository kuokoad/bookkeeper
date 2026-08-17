'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';

import { TextInput } from '@/components/ui/field';
import { Button } from '@/components/ui/button';

export interface CategoryOption {
  id: number;
  name: string;
}

/** Search and filter bar. Pushes state into the URL so results are linkable. */
export function ProductFilters({ categories }: { categories: CategoryOption[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [term, setTerm] = useState(searchParams.get('q') ?? '');

  const category = searchParams.get('category') ?? '';
  const lowOnly = searchParams.get('low') === '1';
  const hasFilters = Boolean(term || category || lowOnly);

  function apply(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === '') params.delete(key);
      else params.set(key, value);
    }
    params.delete('created');
    params.delete('updated');
    startTransition(() => router.push(`/products?${params.toString()}`));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    apply({ q: term.trim() || null });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
      <label htmlFor="product-search" className="sr-only">
        Search products
      </label>
      <TextInput
        id="product-search"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        placeholder="Search name, SKU or barcode"
        className="h-10 w-full sm:w-72"
        autoComplete="off"
        type="search"
      />

      <label htmlFor="category-filter" className="sr-only">
        Filter by category
      </label>
      <select
        id="category-filter"
        value={category}
        onChange={(event) => apply({ category: event.target.value || null })}
        className="h-10 rounded-lg border border-line-strong bg-surface-raised px-3 text-sm text-content"
      >
        <option value="">All categories</option>
        {categories.map((option) => (
          <option key={option.id} value={String(option.id)}>
            {option.name}
          </option>
        ))}
      </select>

      <Button
        type="button"
        size="sm"
        variant={lowOnly ? 'primary' : 'secondary'}
        onClick={() => apply({ low: lowOnly ? null : '1' })}
        aria-pressed={lowOnly}
      >
        Low stock only
      </Button>

      <Button type="submit" size="sm" variant="secondary" disabled={pending}>
        {pending ? 'Searching…' : 'Search'}
      </Button>

      {hasFilters && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setTerm('');
            startTransition(() => router.push('/products'));
          }}
        >
          Clear
        </Button>
      )}
    </form>
  );
}
