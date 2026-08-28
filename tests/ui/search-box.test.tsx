// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * The search box in the top bar.
 *
 * It shipped looking broken. Typing a term and pressing Enter DID search — the
 * results were right there — but the box you typed into came back empty, which
 * reads as nothing having happened. `TopBar` took a `query` prop documented as
 * "echoed back so the box still shows what was searched for", and the layout
 * that renders TopBar is never handed `searchParams` by Next, so the prop could
 * not be filled from where it was used and never was.
 *
 * These assert the three things that were wrong: the term comes back, it keeps
 * coming back when you search again from the results page, and searching still
 * works as a plain form rather than depending on any of this.
 */

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => navigation.params,
}));

const { SearchBox } = await import('@/components/shared/search-box');

afterEach(() => {
  cleanup();
  navigation.params = new URLSearchParams();
});

const box = () => screen.getByRole('searchbox') as HTMLInputElement;

describe('the header search box', () => {
  it('is empty when nothing has been searched for', () => {
    render(<SearchBox />);
    expect(box().value).toBe('');
  });

  it('shows the term that was searched for', () => {
    navigation.params = new URLSearchParams('q=Milo');
    render(<SearchBox />);
    expect(box().value).toBe('Milo');
  });

  it('updates when the same box is used to search again', () => {
    // The input is uncontrolled, so `defaultValue` is read once and ignored
    // afterwards. Without a key tied to the term, refining a search from the
    // results page would leave the PREVIOUS term sitting in the box — the same
    // class of wrongness as showing nothing.
    navigation.params = new URLSearchParams('q=Milo');
    const { rerender } = render(<SearchBox />);
    expect(box().value).toBe('Milo');

    navigation.params = new URLSearchParams('q=Milo Tin');
    rerender(<SearchBox />);
    expect(box().value).toBe('Milo Tin');
  });

  it('searches with a plain GET form, so it works before its JavaScript does', () => {
    render(<SearchBox />);
    const form = screen.getByRole('search');
    expect(form.getAttribute('action')).toBe('/search');
    // No method attribute means GET, which is what puts the term in the URL and
    // makes a result page shareable and bookmarkable.
    expect(form.getAttribute('method')).toBeNull();
    expect(box().name).toBe('q');
  });

  it('does not reuse the id the search page gives its own field', () => {
    // Both were `id="q"`, so /search carried the same id twice. Two labels then
    // point at one input, and the page's own field is the one that loses.
    render(<SearchBox />);
    expect(box().id).toBe('header-search');

    const label = document.querySelector('label');
    expect(label?.getAttribute('for')).toBe('header-search');
  });
});
