// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * The filter drawer, on a phone.
 *
 * A sheet that covers the page is a modal, and a modal that leaves focus behind
 * it is not usable without a mouse: the screen reader goes on announcing the
 * table underneath, and the first Tab walks into rows nobody can see. These
 * assert the three things that make it a real dialog — focus goes in, focus
 * stays in, focus comes back out where it started.
 *
 * happy-dom does not implement native Tab navigation, which is exactly why
 * these tests are meaningful rather than circular: the wrap at each end is
 * performed by the component's own handler, so what is asserted here is the
 * code under test and not the browser's behaviour.
 */

const navigation = vi.hoisted(() => ({
  pushed: [] as string[],
  params: new URLSearchParams(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: (url: string) => {
      navigation.pushed.push(url);
    },
  }),
  useSearchParams: () => navigation.params,
}));

const { FilterBar } = await import('@/components/shared/filter-bar');

function renderBar() {
  return render(
    <FilterBar
      basePath="/sales"
      active={[{ key: 'method', label: 'Method', value: 'Cash' }]}
      fields={[
        { kind: 'search', key: 'q', label: 'Search' },
        {
          kind: 'select',
          key: 'customer',
          label: 'Customer',
          allLabel: 'All customers',
          options: [{ value: '1', label: 'Kofi Mensah' }],
        },
      ]}
    />,
  );
}

/** The drawer's trigger is the only control rendered at phone width. */
function openDrawer(): HTMLElement {
  const trigger = screen.getByRole('button', { name: /^Filters/ });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog');
}

function focusable(): HTMLElement[] {
  return Array.from(
    dialog().querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

beforeEach(() => {
  navigation.pushed = [];
  navigation.params = new URLSearchParams('method=CASH');
});

afterEach(() => {
  cleanup();
});

describe('the filter drawer', () => {
  it('moves focus into the dialog when it opens', () => {
    renderBar();
    openDrawer();

    expect(dialog().contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(focusable()[0]);
  });

  it('keeps Tab inside the dialog at the last control', () => {
    renderBar();
    openDrawer();

    const controls = focusable();
    const last = controls[controls.length - 1]!;
    last.focus();

    fireEvent.keyDown(dialog(), { key: 'Tab' });

    expect(document.activeElement).toBe(controls[0]);
  });

  it('keeps Shift+Tab inside the dialog at the first control', () => {
    renderBar();
    openDrawer();

    const controls = focusable();
    controls[0]!.focus();

    fireEvent.keyDown(dialog(), { key: 'Tab', shiftKey: true });

    expect(document.activeElement).toBe(controls[controls.length - 1]);
  });

  it('leaves the browser to handle Tab in the middle of the dialog', () => {
    renderBar();
    openDrawer();

    const controls = focusable();
    // A control that is neither end. The handler must not touch it, or every
    // Tab would jump to an end instead of stepping through the fields.
    const middle = controls[1]!;
    middle.focus();

    fireEvent.keyDown(dialog(), { key: 'Tab' });

    expect(document.activeElement).toBe(middle);
  });

  it('closes on Escape and puts focus back where it came from', () => {
    renderBar();
    const trigger = openDrawer();

    fireEvent.keyDown(dialog(), { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on the Close button and puts focus back too', () => {
    renderBar();
    const trigger = openDrawer();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  /**
   * The scrim closes the drawer on a tap, but it sits OUTSIDE the dialog — as a
   * button it would be a tab stop the trap cannot reach, which is the one place
   * focus could leak out of a modal.
   */
  it('does not make the backdrop a tab stop', () => {
    renderBar();
    openDrawer();

    const backdrop = document.querySelector('[aria-hidden="true"].absolute.inset-0');
    expect(backdrop).not.toBeNull();
    expect(backdrop?.tagName).toBe('DIV');
    // Not a button, and nothing inside it can take focus either.
    expect(backdrop?.querySelector('a, button, input, select, textarea')).toBeNull();

    /*
      Nothing focusable is hidden from assistive technology. An aria-hidden
      element that can still be tabbed to is the specific defect that makes a
      screen reader announce nothing while the focus ring moves.
    */
    const all = Array.from(
      document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea'),
    );
    expect(all.some((element) => element.closest('[aria-hidden="true"]') !== null)).toBe(false);
  });
});
