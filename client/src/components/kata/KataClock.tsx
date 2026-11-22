import { memo, useEffect, useState } from 'react';

const TIME = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});
const DATE = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/**
 * A ticking IST clock that owns its own timer.
 *
 * The clock used to live as state at the top of the 3,800-line weighbridge
 * page, so every second re-rendered the whole screen - the form, both live
 * camera boxes and the tables. Here only this span re-renders.
 */
export const KataClock = memo(function KataClock({ part = 'time', className }: { part?: 'time' | 'date'; className?: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // Date only needs a slow tick; the time changes every second.
    const id = setInterval(() => setNow(new Date()), part === 'time' ? 1000 : 30_000);
    return () => clearInterval(id);
  }, [part]);
  return <span className={className}>{part === 'time' ? TIME.format(now) : DATE.format(now).replace(/\//g, '-')}</span>;
});
