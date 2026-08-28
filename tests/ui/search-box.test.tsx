// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * The search box in the top bar.
 *
 * It behaves like "Find a product" on the till: results as you type, click one
 * to go there, Enter takes the first. The till can do that from memory because
 * it loads the whole catalogue once; this cannot, because it searches seven
 * kinds of record and every one is permission-filtered. So it asks the server,
 * and that difference is what these tests are mostly about — a request per
 * WORD rather than per keystroke, and never showing the answer to a question
 * that is no longer in the box.
 *
 * The form underneath stays a plain GET to /search. Everything here is an
 * enhancement on top of something that already worked, and the last test says
 * so.
 */

const navigation = vi.hoisted(() => ({
  params: new URLSearchParams(),
  pushed: [] as string[],
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => navigation.params,
  useRouter: () => ({
    push: (url: string) => {
      navigation.pushed.push(url);
    },
  }),
}));

const { SearchBox } = await import('@/components/shared/search-box');

const MILO = {
  query: 'Milo',
  total: 2,
  truncated: false,
  groups: [
    {
      label: 'Products',
      hits: [
        {
          kind: 'product',
          id: 3,
          title: 'Milo Tin 400g',
          detail: 'MILO400 · tin',
          href: '/products/3/edit',
        },
      ],
    },
    {
      label: 'Batches',
      hits: [
        {
          kind: 'batch',
          id: 3,
          title: 'BAT-00003',
          detail: 'Milo Tin 400g · 25 tin left',
          href: '/inventory/batches/3',
        },
      ],
    },
  ],
};

let calls: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  calls = [];
  vi.stubGlobal('fetch', (url: string) => {
    calls.push(url);
    const asked = new URL(url, 'http://x').searchParams.get('q') ?? '';
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ...MILO, query: asked }),
    } as Response);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  navigation.params = new URLSearchParams();
  navigation.pushed = [];
});

const box = () => screen.getByRole('combobox') as HTMLInputElement;

async function type(value: string) {
  fireEvent.change(box(), { target: { value } });
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
}

describe('the header search box', () => {
  it('shows results while you type, without submitting anything', async () => {
    render(<SearchBox />);
    await type('Milo');

    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(screen.getByText('Milo Tin 400g')).toBeTruthy();
    expect(navigation.pushed).toEqual([]);
  });

  it('asks once for a word, not once per letter', async () => {
    // A shop's connection is not a developer's. Typing nine characters used to
    // be nine round trips; the timer and the abort make it one.
    render(<SearchBox />);
    for (const value of ['C', 'Co', 'Coc', 'Coca', 'Coca-', 'Coca-C', 'Coca-Co', 'Coca-Col']) {
      fireEvent.change(box(), { target: { value } });
      await act(async () => {
        vi.advanceTimersByTime(40);
      });
    }
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('q=Coca-Col');
  });

  it('does not ask about a single character', async () => {
    // The service refuses anything shorter than two, so the request could only
    // ever come back empty.
    render(<SearchBox />);
    await type('M');
    expect(calls).toHaveLength(0);
  });

  it('goes to a result when you click it', async () => {
    render(<SearchBox />);
    await type('Milo');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));

    fireEvent.click(screen.getByText('BAT-00003'));
    expect(navigation.pushed).toEqual(['/inventory/batches/3']);
  });

  it('takes the first result on Enter, the way the till treats a scan', async () => {
    render(<SearchBox />);
    await type('Milo');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));

    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(navigation.pushed).toEqual(['/products/3/edit']);
  });

  it('moves the highlight with the arrow keys and opens what is highlighted', async () => {
    render(<SearchBox />);
    await type('Milo');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));

    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]?.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(navigation.pushed).toEqual(['/inventory/batches/3']);
  });

  it('offers the whole list, because Enter only takes one of them', async () => {
    render(<SearchBox />);
    await type('Milo');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));

    fireEvent.click(screen.getByText(/See all results/));
    expect(navigation.pushed).toEqual(['/search?q=Milo']);
  });

  it('never shows the answer to a question that is no longer in the box', async () => {
    // Results carry the query they answer. Without that check, deleting a
    // character leaves the previous list on screen looking current — and a
    // result somebody clicks is a record they did not search for.
    render(<SearchBox />);
    await type('Milo');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));

    fireEvent.change(box(), { target: { value: 'Mil' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('shows the term after a search, so it can be refined', async () => {
    navigation.params = new URLSearchParams('q=Milo');
    render(<SearchBox />);
    expect(box().value).toBe('Milo');
  });

  it('still searches with a plain GET form, so it works before its JavaScript', () => {
    render(<SearchBox />);
    const form = screen.getByRole('search');
    expect(form.getAttribute('action')).toBe('/search');
    // No method means GET, which is what puts the term in the URL.
    expect(form.getAttribute('method')).toBeNull();
    expect(box().name).toBe('q');
    // And not the id the search page gives its own field.
    expect(box().id).toBe('header-search');
  });
});
