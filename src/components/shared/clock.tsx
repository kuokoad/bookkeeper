'use client';

import { useEffect, useState } from 'react';

/**
 * The date and time, kept current.
 *
 * Almost everything in this application is rendered on the server and stays
 * true until the page is reloaded. A clock is the exception: a server-rendered
 * time is correct for one second and misleading afterwards, and a till screen
 * left open all morning would show the time it was opened. Someone would read
 * it and be wrong — worse than showing nothing.
 *
 * So this is one of the few client components in the app, and it does the
 * smallest possible amount: re-reads the clock every thirty seconds. It shows
 * no money, so it breaks no rule about figures.
 *
 * The server's rendering is passed in as `initial` so the space is filled on
 * first paint rather than jumping into place. `suppressHydrationWarning` is
 * needed because the server and the browser genuinely disagree here — a second
 * or two apart — and that disagreement is the point rather than a bug.
 */

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

export function Clock({ initialDate, initialTime }: { initialDate: string; initialTime: string }) {
  const [now, setNow] = useState<{ date: string; time: string }>({
    date: initialDate,
    time: initialTime,
  });

  useEffect(() => {
    const tick = () => {
      const at = new Date();
      setNow({ date: DATE_FORMAT.format(at), time: TIME_FORMAT.format(at) });
    };

    tick(); // correct immediately, rather than up to thirty seconds late
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="text-right" suppressHydrationWarning>
      <p className="tabular text-lg font-semibold text-content">{now.time}</p>
      <p className="text-xs text-content-muted">{now.date}</p>
    </div>
  );
}
