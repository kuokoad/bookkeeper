'use client';

import { useEffect, useState } from 'react';

import { formatClockDate, formatClockTime, msUntilNextSecond } from '@/lib/clock-format';

/**
 * The date and time, kept current.
 *
 * Almost everything in this application is rendered on the server and stays
 * true until the page is reloaded. A clock is the exception: a server-rendered
 * time is correct for one second and misleading afterwards, and a till screen
 * left open all morning would show the time it was opened. Someone would read
 * it and be wrong — worse than showing nothing.
 *
 * Seconds are displayed deliberately. A minute-resolution clock polled every
 * thirty seconds is indistinguishable from a broken one: nothing changes for up
 * to a minute, and the minute itself can flip half a minute late. A moving
 * second hand is how a person tells at a glance that the screen is live rather
 * than a page left open since this morning.
 *
 * That legibility cuts both ways, which is why the two guards below matter.
 *
 * The server's rendering is passed in as `initial` so the space is filled on
 * first paint rather than jumping into place. `suppressHydrationWarning` is
 * needed because the server and the browser genuinely disagree here — a second
 * or two apart — and that disagreement is the point rather than a bug.
 */
export function Clock({ initialDate, initialTime }: { initialDate: string; initialTime: string }) {
  const [now, setNow] = useState<{ date: string; time: string }>({
    date: initialDate,
    time: initialTime,
  });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;

    const tick = () => {
      const at = new Date();
      setNow({ date: formatClockDate(at), time: formatClockTime(at) });
    };

    // Scheduled to the next whole second rather than every 1000ms, so drift and
    // a slow frame cannot make the display skip a second.
    const schedule = () => {
      timer = setTimeout(() => {
        tick();
        schedule();
      }, msUntilNextSecond(Date.now()));
    };

    tick();
    schedule();

    /**
     * Browsers throttle timers in a hidden tab — Chrome to roughly once a
     * minute — and a sleeping machine stops them altogether. Coming back to a
     * clock frozen at the time you left is precisely the "this is broken"
     * impression the seconds were added to dispel, so the time is re-read the
     * moment the page is looked at again.
     */
    const resync = () => {
      if (document.visibilityState === 'visible') {
        tick();
        clearTimeout(timer);
        schedule();
      }
    };

    document.addEventListener('visibilitychange', resync);
    window.addEventListener('focus', resync);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', resync);
      window.removeEventListener('focus', resync);
    };
  }, []);

  return (
    <div className="text-right" suppressHydrationWarning>
      <p className="tabular text-lg font-semibold text-content">{now.time}</p>
      <p className="text-xs text-content-muted">{now.date}</p>
    </div>
  );
}
