// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { DateField } from '@/components/ui/date-field';

/**
 * The date field that replaced `<input type="date">`.
 *
 * What these hold true is what the native control could not do: an order that
 * does not depend on the browser's locale, and a calendar that refuses a day
 * inside a locked period. The submitted value must stay 'YYYY-MM-DD' in every
 * case, because the whole server side was written against that and none of it
 * changed.
 */

const TODAY = '2026-08-29';

afterEach(cleanup);

/** What the form would actually post. */
const submitted = (container: HTMLElement): string =>
  (container.querySelector('input[type=hidden]') as HTMLInputElement).value;

const seg = (label: string): HTMLInputElement =>
  screen.getByLabelText(label) as HTMLInputElement;

describe('the boxes', () => {
  it('says which part is which, so 03/04 is never a guess', () => {
    render(<DateField name="d" defaultValue="2026-04-03" today={TODAY} />);
    expect(seg('Day').value).toBe('03');
    expect(seg('Month').value).toBe('04');
    expect(seg('Year').value).toBe('2026');
  });

  it('spells the date out underneath', () => {
    render(<DateField name="d" defaultValue="2026-04-03" today={TODAY} />);
    expect(screen.getByText('Friday, 3 April 2026')).toBeTruthy();
  });

  it('submits YYYY-MM-DD, whatever the boxes look like', () => {
    const { container } = render(<DateField name="d" defaultValue="2026-04-03" today={TODAY} />);
    expect(submitted(container)).toBe('2026-04-03');
  });

  it('builds a date once all three boxes are filled, and not before', () => {
    const { container } = render(<DateField name="d" today={TODAY} />);

    fireEvent.change(seg('Day'), { target: { value: '03' } });
    expect(submitted(container)).toBe('');

    fireEvent.change(seg('Month'), { target: { value: '04' } });
    expect(submitted(container)).toBe('');

    fireEvent.change(seg('Year'), { target: { value: '2026' } });
    expect(submitted(container)).toBe('2026-04-03');
  });

  it('refuses anything that is not a digit', () => {
    render(<DateField name="d" today={TODAY} />);
    fireEvent.change(seg('Day'), { target: { value: 'a3-x' } });
    expect(seg('Day').value).toBe('3');
  });

  it('steps a part with the arrow keys', () => {
    const { container } = render(<DateField name="d" defaultValue="2026-04-03" today={TODAY} />);

    fireEvent.keyDown(seg('Day'), { key: 'ArrowUp' });
    expect(submitted(container)).toBe('2026-04-04');

    fireEvent.keyDown(seg('Month'), { key: 'ArrowDown' });
    expect(submitted(container)).toBe('2026-03-04');

    fireEvent.keyDown(seg('Year'), { key: 'ArrowUp' });
    expect(submitted(container)).toBe('2027-03-04');
  });

  /** 31 January stepped a month is 28 February, not 3 March. */
  it('does not overflow a month when stepping onto a shorter one', () => {
    const { container } = render(<DateField name="d" defaultValue="2026-01-31" today={TODAY} />);
    fireEvent.keyDown(seg('Month'), { key: 'ArrowUp' });
    expect(submitted(container)).toBe('2026-02-28');
  });
});

describe('the calendar', () => {
  const open = () => fireEvent.click(screen.getByLabelText('Open calendar'));

  it('opens on the month the value is in', () => {
    render(<DateField name="d" defaultValue="2026-04-03" today={TODAY} />);
    open();
    expect(screen.getByText('April 2026')).toBeTruthy();
  });

  it('starts the week on Monday, as the shop does', () => {
    render(<DateField name="d" defaultValue="2026-04-03" today={TODAY} />);
    open();
    const headings = screen.getAllByText(/^(Mon|Sun)$/).map((node) => node.textContent);
    expect(headings[0]).toBe('Mon');
  });

  it('pages backwards and forwards, carrying the year', () => {
    render(<DateField name="d" defaultValue="2026-01-15" today={TODAY} />);
    open();
    fireEvent.click(screen.getByLabelText('Previous month'));
    expect(screen.getByText('December 2025')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Next month'));
    fireEvent.click(screen.getByLabelText('Next month'));
    expect(screen.getByText('February 2026')).toBeTruthy();
  });

  it('picks a day and closes', () => {
    const { container } = render(<DateField name="d" defaultValue="2026-04-03" today={TODAY} />);
    open();
    fireEvent.click(screen.getByLabelText('Wednesday, 15 April 2026'));
    expect(submitted(container)).toBe('2026-04-15');
    expect(screen.queryByText('April 2026')).toBeNull();
  });

  it('offers Today and Yesterday, which is most of what gets typed', () => {
    const { container } = render(<DateField name="d" today={TODAY} />);
    open();
    fireEvent.click(screen.getByText('Today'));
    expect(submitted(container)).toBe(TODAY);

    open();
    fireEvent.click(screen.getByText('Yesterday'));
    expect(submitted(container)).toBe('2026-08-28');
  });

  it('closes on Escape', () => {
    render(<DateField name="d" defaultValue="2026-04-03" today={TODAY} />);
    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('April 2026')).toBeNull();
  });
});

/**
 * The reason this component exists rather than the native one. A browser's own
 * calendar cannot be told that the books are locked before 1 July, so somebody
 * could pick 20 June, fill in a whole sale, and be refused on submit.
 */
describe('a day inside a locked period', () => {
  const lockedOpen = () => {
    const rendered = render(
      <DateField
        name="d"
        defaultValue="2026-07-15"
        min="2026-07-01"
        minReason="The books are locked before 1 July 2026."
        today={TODAY}
      />,
    );
    fireEvent.click(screen.getByLabelText('Open calendar'));
    return rendered;
  };

  /**
   * `aria-disabled`, not `disabled`. A disabled button cannot take focus, so
   * the arrow keys would dead-end at the edge of a locked period with no way
   * past it. This stays reachable by keyboard and still refuses the click.
   */
  it('is marked unavailable but stays reachable by keyboard', () => {
    lockedOpen();
    expect(screen.getByLabelText('Tuesday, 30 June 2026').getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(screen.getByLabelText('Wednesday, 1 July 2026').getAttribute('aria-disabled')).toBe(
      'false',
    );
  });

  it('says why, rather than doing nothing when clicked', () => {
    lockedOpen();
    fireEvent.click(screen.getByLabelText('Tuesday, 30 June 2026'));
    expect(screen.getByText('The books are locked before 1 July 2026.')).toBeTruthy();
  });

  it('leaves the value alone when one is attempted', () => {
    const { container } = lockedOpen();
    fireEvent.click(screen.getByLabelText('Tuesday, 30 June 2026'));
    expect(submitted(container)).toBe('2026-07-15');
  });

  it('will not let the arrow keys walk past the lock either', () => {
    const { container } = render(
      <DateField name="d" defaultValue="2026-07-01" min="2026-07-01" today={TODAY} />,
    );
    fireEvent.keyDown(seg('Day'), { key: 'ArrowDown' });
    expect(submitted(container)).toBe('2026-07-01');
  });

  it('refuses a day after a ceiling too', () => {
    const { container } = render(
      <DateField name="d" defaultValue="2026-08-15" max={TODAY} today={TODAY} />,
    );
    fireEvent.click(screen.getByLabelText('Open calendar'));
    expect(screen.getByLabelText('Monday, 31 August 2026').getAttribute('aria-disabled')).toBe(
      'true',
    );
    fireEvent.click(screen.getByLabelText('Monday, 31 August 2026'));
    expect(submitted(container)).toBe('2026-08-15');
  });
});

describe('as a controlled field', () => {
  it('reports every change to its parent', () => {
    const seen: string[] = [];
    render(
      <DateField value="2026-04-03" onChange={(next) => seen.push(next)} today={TODAY} />,
    );
    fireEvent.click(screen.getByLabelText('Open calendar'));
    fireEvent.click(screen.getByLabelText('Wednesday, 15 April 2026'));
    expect(seen).toEqual(['2026-04-15']);
  });

  it('can be cleared when it is not required', () => {
    const { container } = render(<DateField name="d" defaultValue="2026-04-03" today={TODAY} />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    fireEvent.click(screen.getByText('Clear'));
    expect(submitted(container)).toBe('');
    expect(seg('Day').value).toBe('');
  });

  it('offers no Clear when the date is required', () => {
    render(<DateField name="d" defaultValue="2026-04-03" required today={TODAY} />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    expect(screen.queryByText('Clear')).toBeNull();
  });
});

/**
 * Where the calendar goes.
 *
 * It used to be absolutely positioned inside the field, which meant two
 * problems: it only ever grew downward, so a field low on the page pushed it
 * off-screen, and it was clipped by any scrolling ancestor — the filter drawer
 * on a phone is `max-h-[85vh] overflow-y-auto`, and the calendar was cut off
 * inside it whichever way it opened.
 *
 * happy-dom has no layout engine, so the measured placement itself is not
 * assertable here. What IS assertable is the mechanism that makes it possible.
 */
describe('where the calendar opens', () => {
  const popover = (container: HTMLElement) =>
    container.ownerDocument.querySelector('[role=dialog]') as HTMLElement | null;

  it('goes into the top layer, so no scrolling parent can clip it', () => {
    const { container } = render(<DateField name="d" defaultValue="2026-04-03" today={TODAY} />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    expect(popover(container)?.getAttribute('popover')).toBe('manual');
  });

  it('is positioned against the viewport, not against the field', () => {
    const { container } = render(<DateField name="d" defaultValue="2026-04-03" today={TODAY} />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    // `absolute` inherits the clipping of whatever it sits inside; `fixed`
    // combined with the top layer does not.
    expect(popover(container)?.style.position).toBe('fixed');
  });

  /**
   * A calendar that hangs in place while the field slides away underneath reads
   * as detached from the thing it belongs to.
   */
  it('closes when the page scrolls', () => {
    render(<DateField name="d" defaultValue="2026-04-03" today={TODAY} />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    expect(screen.getByText('April 2026')).toBeTruthy();

    fireEvent.scroll(window);
    expect(screen.queryByText('April 2026')).toBeNull();
  });

  it('closes when a scrolling panel inside the page moves, not just the window', () => {
    // Capture phase: a scroll event on a nested container never bubbles to
    // window, so a listener without it would miss the filter drawer entirely.
    render(<DateField name="d" defaultValue="2026-04-03" today={TODAY} />);
    fireEvent.click(screen.getByLabelText('Open calendar'));

    const inner = document.createElement('div');
    document.body.appendChild(inner);
    fireEvent.scroll(inner);
    expect(screen.queryByText('April 2026')).toBeNull();
  });
});

/**
 * Walking the calendar without a mouse.
 *
 * A grid takes ONE tab stop, not forty two: the focused day carries tabIndex 0
 * and every other day carries -1, so Tab moves past the whole calendar and the
 * arrows move within it. That is the roving-focus pattern the ARIA practices
 * describe for this control, and it was the last thing missing against a
 * component library's version.
 */
describe('the keyboard, inside the calendar', () => {
  const openOn = (value: string) => {
    render(<DateField name="d" defaultValue={value} today={TODAY} />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    return screen.getByRole('grid');
  };

  const focused = () => document.activeElement?.getAttribute('data-date');

  it('starts on the chosen day', () => {
    openOn('2026-04-15');
    expect(focused()).toBe('2026-04-15');
  });

  it('is a single tab stop, not forty two', () => {
    const grid = openOn('2026-04-15');
    const reachable = Array.from(grid.querySelectorAll('[data-date]')).filter(
      (cell) => cell.getAttribute('tabindex') === '0',
    );
    expect(reachable).toHaveLength(1);
  });

  it('moves a day with left and right', () => {
    const grid = openOn('2026-04-15');
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(focused()).toBe('2026-04-16');
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    expect(focused()).toBe('2026-04-14');
  });

  it('moves a week with up and down, which is what a grid means', () => {
    const grid = openOn('2026-04-15');
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(focused()).toBe('2026-04-22');
    fireEvent.keyDown(grid, { key: 'ArrowUp' });
    fireEvent.keyDown(grid, { key: 'ArrowUp' });
    expect(focused()).toBe('2026-04-08');
  });

  it('moves to the ends of the WEEK with Home and End, not the month', () => {
    // 15 April 2026 is a Wednesday.
    const grid = openOn('2026-04-15');
    fireEvent.keyDown(grid, { key: 'Home' });
    expect(focused()).toBe('2026-04-13'); // the Monday
    fireEvent.keyDown(grid, { key: 'End' });
    expect(focused()).toBe('2026-04-19'); // the Sunday
  });

  it('pages a month, and a year with Shift', () => {
    const grid = openOn('2026-04-15');
    fireEvent.keyDown(grid, { key: 'PageDown' });
    expect(focused()).toBe('2026-05-15');
    fireEvent.keyDown(grid, { key: 'PageUp', shiftKey: true });
    expect(focused()).toBe('2025-05-15');
  });

  /** Walking off the edge of a month should show the next one, not stop. */
  it('turns the page when the keyboard leaves the month', () => {
    const grid = openOn('2026-04-30');
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(focused()).toBe('2026-05-01');
    expect(screen.getByText('May 2026')).toBeTruthy();
  });

  it('carries the year backwards across January', () => {
    const grid = openOn('2026-01-01');
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    expect(focused()).toBe('2025-12-31');
    expect(screen.getByText('December 2025')).toBeTruthy();
  });

  /**
   * The reason locked days are aria-disabled rather than disabled: a disabled
   * button cannot take focus, so this walk would dead-end at 1 July with no way
   * back to June to see what is there.
   */
  it('can walk into a locked period, and still cannot choose from it', () => {
    const { container } = render(
      <DateField
        name="d"
        defaultValue="2026-07-01"
        min="2026-07-01"
        minReason="The books are locked before 1 July 2026."
        today={TODAY}
      />,
    );
    fireEvent.click(screen.getByLabelText('Open calendar'));
    const grid = screen.getByRole('grid');

    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    expect(focused()).toBe('2026-06-30');

    fireEvent.click(screen.getByLabelText('Tuesday, 30 June 2026'));
    expect(submitted(container)).toBe('2026-07-01');
    expect(screen.getByText('The books are locked before 1 July 2026.')).toBeTruthy();
  });
});
