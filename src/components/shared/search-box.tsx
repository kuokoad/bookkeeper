'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import type { SearchHit, SearchResults } from '@/services/search.service';
import { Icon } from '@/components/ui/icon';

/**
 * The search box in the top bar.
 *
 * Behaves like "Find a product" on the till: results appear as you type, you
 * click one to go straight there, and Enter takes the first. The difference is
 * where the records come from. The till loads the whole catalogue once and
 * filters it in the browser, which it can do because a shop has hundreds of
 * products. This searches products, batches, customers, suppliers, receipts,
 * purchases and journal entries, permission-filtered per record type, so it
 * asks the server — the SAME `search()` the /search page runs, so the dropdown
 * and the full page can never disagree.
 *
 * Search still works without any of this. The form is a plain GET to /search,
 * so before the JavaScript arrives, or if it never does, typing and pressing
 * Enter goes to the results page exactly as it always did. Everything below is
 * an enhancement on top of a working form.
 *
 * Typing is not a search. Each keystroke restarts a short timer and aborts the
 * request in flight, so a person typing "Coca-Cola" makes one request rather
 * than nine — which matters on a shop's connection, not on a developer's.
 */

/** Long enough to stop mid-word requests, short enough to feel immediate. */
const DEBOUNCE_MS = 180;

export function SearchBox() {
  const router = useRouter();
  const submitted = useSearchParams().get('q') ?? '';

  const [term, setTerm] = useState(submitted);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  // Landing on /search?q=… must show that term. Adjusted DURING RENDER rather
  // than in an effect: an effect would paint the old term first and correct it
  // afterwards, and the linter rightly refuses it. Comparing against the last
  // submitted query is what stops this fighting the person for the field on
  // every keystroke — it only acts when a NEW search has actually happened.
  const [seen, setSeen] = useState(submitted);
  if (submitted !== seen) {
    setSeen(submitted);
    setTerm(submitted);
    setOpen(false);
  }

  useEffect(() => {
    const query = term.trim();
    // The service itself refuses a single character, so asking would be a
    // request whose answer is always empty. Nothing is cleared here: results
    // carry the query they answer, and anything that does not match the box is
    // ignored below.
    if (query.length < 2) return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : null))
        .then((data: SearchResults | null) => {
          setResults(data);
          setActive(-1);
        })
        // An abort is this component's own doing, and a failed request means
        // the dropdown simply does not appear. Neither is worth shouting about
        // on a shop's screen: the form underneath still works.
        .catch(() => undefined);
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term]);

  // Only the answer to the question currently in the box. Deleting a character
  // or typing another leaves the previous answer on screen for a moment
  // otherwise — results for a term the person can no longer see, which is the
  // kind of wrong that gets acted on.
  const fresh = results !== null && results.query === term.trim() ? results : null;
  const hits: SearchHit[] = fresh?.groups.flatMap((group) => group.hits) ?? [];
  const showing = open && term.trim().length >= 2;

  function go(hit: SearchHit) {
    setOpen(false);
    setTerm('');
    inputRef.current?.blur();
    router.push(hit.href);
  }

  function seeAll() {
    setOpen(false);
    router.push(`/search?q=${encodeURIComponent(term.trim())}`);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (hits.length === 0) return;
      event.preventDefault();
      setOpen(true);
      setActive((current) => {
        const next = event.key === 'ArrowDown' ? current + 1 : current - 1;
        if (next < 0) return hits.length - 1;
        if (next >= hits.length) return 0;
        return next;
      });
      return;
    }

    if (event.key !== 'Enter') return;

    // Enter takes the first result, the way the till treats a scanned barcode.
    // Nothing highlighted and nothing found falls through to the form, which
    // submits to /search — so Enter always does something, and what it does
    // while results are still loading is the thing that used to happen.
    const chosen = active >= 0 ? hits[active] : hits[0];
    if (!chosen) return;
    event.preventDefault();
    go(chosen);
  }

  return (
    <form
      action="/search"
      role="search"
      className="relative hidden min-w-0 flex-1 lg:block"
      // Clicking away closes the list, but only when focus actually leaves the
      // box AND the list — otherwise clicking a result would close it before
      // the click landed.
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <label htmlFor="header-search" className="sr-only">
        Search products, customers, suppliers and receipts
      </label>

      <div className="relative max-w-md">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-content-subtle">
          <Icon name="search" className="h-4 w-4" />
        </span>
        <input
          ref={inputRef}
          id="header-search"
          name="q"
          type="search"
          value={term}
          onChange={(event) => {
            setTerm(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          autoComplete="off"
          role="combobox"
          aria-expanded={showing && hits.length > 0}
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          placeholder="Search a product, customer or receipt"
          className="h-9 w-full rounded-lg border border-line-strong bg-surface pl-9 pr-3 text-sm text-content placeholder:text-content-subtle focus:outline-none focus-visible:outline-2 focus-visible:outline-accent"
        />

        {showing && fresh !== null && (
          <div
            className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-xl border border-line bg-surface-raised shadow-lg"
            style={{ boxShadow: 'var(--card-shadow, 0 10px 22px rgb(0 0 0 / 0.12))' }}
          >
            {hits.length === 0 ? (
              <p className="px-3 py-3 text-sm text-content-muted">
                Nothing matches “{term.trim()}”.
              </p>
            ) : (
              <>
                <ul id={listId} role="listbox" aria-label="Search results" className="max-h-80 overflow-y-auto">
                  {fresh.groups.map((group) => (
                    <li key={group.label}>
                      <p className="border-b border-line bg-surface-sunken px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-content-subtle">
                        {group.label}
                      </p>
                      <ul>
                        {group.hits.map((hit) => {
                          const index = hits.indexOf(hit);
                          return (
                            <li key={`${hit.kind}-${hit.id}`}>
                              <button
                                type="button"
                                id={`${listId}-${index}`}
                                role="option"
                                aria-selected={index === active}
                                onMouseEnter={() => setActive(index)}
                                onClick={() => go(hit)}
                                className={`flex w-full items-start justify-between gap-3 px-3 py-2 text-left ${
                                  index === active ? 'bg-surface-sunken' : ''
                                }`}
                              >
                                <span className="min-w-0">
                                  <span className="block truncate text-sm font-medium text-content">
                                    {hit.title}
                                  </span>
                                  <span className="block truncate text-xs text-content-subtle">
                                    {hit.detail}
                                  </span>
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  ))}
                </ul>

                {/* Enter goes to the first result, so this is the way to the
                    whole list — including anything a group had to cut. */}
                <button
                  type="button"
                  onClick={seeAll}
                  className="block w-full border-t border-line px-3 py-2 text-left text-xs font-medium text-accent hover:bg-surface-sunken"
                >
                  See all results for “{term.trim()}”
                  {fresh.truncated ? ' — more than shown here' : ''}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </form>
  );
}
