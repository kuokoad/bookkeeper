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

  it('cannot be clicked', () => {
    lockedOpen();
    expect((screen.getByLabelText('Tuesday, 30 June 2026') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByLabelText('Wednesday, 1 July 2026') as HTMLButtonElement).disabled).toBe(
      false,
    );
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
    render(<DateField name="d" defaultValue="2026-08-15" max={TODAY} today={TODAY} />);
    fireEvent.click(screen.getByLabelText('Open calendar'));
    expect((screen.getByLabelText('Monday, 31 August 2026') as HTMLButtonElement).disabled).toBe(
      true,
    );
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
