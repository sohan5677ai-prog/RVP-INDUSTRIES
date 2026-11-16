import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';

// Login reminders used to mount three independent <Dialog open> at once, so the
// dispatch, sales-dues and PO popups stacked on top of each other and whichever
// mounted last stole the screen. They now share one queue: exactly one is on
// screen at a time, in the priority order below, and closing one hands over to
// the next after a short beat (Radix needs the previous dialog fully unmounted
// before the next opens, else the body keeps pointer-events:none and the new
// popup looks dead).

export type ReminderSlotId = 'support-reply' | 'festivals' | 'user-notes' | 'sales-dues' | 'dispatch' | 'purchase-orders';

// A developer's answer to a reported problem comes first - it may well be the
// reason a number in the reminders behind it looks different today. Then upcoming festivals/holidays,
// then custom user notes/reminders, then money, then goods going out, then goods coming in.
const ORDER: ReminderSlotId[] = ['support-reply', 'festivals', 'user-notes', 'sales-dues', 'dispatch', 'purchase-orders'];

const HANDOVER_MS = 320;

// The whole run-through is a once-a-day nudge, not a once-a-page one: a plain
// browser refresh used to replay every popup, because the queue's "done" list
// lives in React state only. We stamp the day the first popup actually opens
// and Layout refuses to mount the queue again until the date changes.
const SHOWN_KEY = 'reminders:lastShownDate';

/** Local calendar day - toISOString() would roll the gate over at 5:30am IST. */
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** True once today's run-through has been seen on this browser, for this user. */
export function remindersShownToday(userKey: string) {
  try {
    return localStorage.getItem(`${SHOWN_KEY}:${userKey}`) === todayKey();
  } catch {
    return false; // private mode / storage blocked - show them rather than hide them
  }
}

function markRemindersShown(userKey: string) {
  try {
    localStorage.setItem(`${SHOWN_KEY}:${userKey}`, todayKey());
  } catch { /* nothing to do; the popups simply come back next refresh */ }
}

interface ReminderQueueValue {
  setReady: (id: ReminderSlotId, ready: boolean) => void;
  finish: (id: ReminderSlotId) => void;
  active: ReminderSlotId | null;
  /** Every reminder that has something to say, finished or not - the "of 3". */
  all: ReminderSlotId[];
}

const Ctx = createContext<ReminderQueueValue | null>(null);

export function ReminderQueueProvider(
  { children, userKey = 'anon' }: { children: React.ReactNode; userKey?: string },
) {
  const [ready, setReadyMap] = useState<Partial<Record<ReminderSlotId, boolean>>>({});
  const [done, setDone] = useState<ReminderSlotId[]>([]);
  // Blocks the next popup for one beat while the previous one animates out.
  const [handingOver, setHandingOver] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const setReady = useCallback((id: ReminderSlotId, isReady: boolean) => {
    setReadyMap((prev) => (prev[id] === isReady ? prev : { ...prev, [id]: isReady }));
  }, []);

  const finish = useCallback((id: ReminderSlotId) => {
    setHandingOver(true);
    setDone((prev) => (prev.includes(id) ? prev : [...prev, id]));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHandingOver(false), HANDOVER_MS);
  }, []);

  // Whoever is on screen right now. Held in state rather than derived, so a
  // higher-priority reminder whose query resolves late queues up behind the one
  // already open instead of yanking it away mid-read.
  const [current, setCurrent] = useState<ReminderSlotId | null>(null);

  const pending = useMemo(
    () => ORDER.filter((id) => ready[id] && !done.includes(id)),
    [ready, done],
  );

  useEffect(() => {
    if (handingOver) return;
    // Keep the current one up until it is finished (or runs out of items).
    if (current && pending.includes(current)) return;
    setCurrent(pending[0] ?? null);
  }, [pending, handingOver, current]);

  // Stamp the day only when something is genuinely on screen, so a quiet morning
  // does not spend the day's allowance before any reminder has anything to say.
  useEffect(() => {
    if (current) markRemindersShown(userKey);
  }, [current, userKey]);

  const value = useMemo<ReminderQueueValue>(() => ({
    setReady,
    finish,
    active: handingOver ? null : current,
    all: ORDER.filter((id) => ready[id] || done.includes(id)),
  }), [ready, done, handingOver, current, setReady, finish]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Claims this reminder's place in the login queue.
 *
 * @param id     which reminder this is
 * @param hasItems whether it actually has something to show right now
 * @returns `open`   - render the dialog only when this is true
 *          `close`  - call when the user is finished with it; hands over to the next
 *          `step`/`total` - "2 of 3" progress, so the user knows more is coming
 */
export function useReminderSlot(id: ReminderSlotId, hasItems: boolean) {
  const ctx = useContext(Ctx);

  useEffect(() => {
    ctx?.setReady(id, hasItems);
  }, [ctx, id, hasItems]);

  const close = useCallback(() => ctx?.finish(id), [ctx, id]);

  // Outside a provider (e.g. a page rendering a reminder on its own) the slot
  // stays permissive rather than silently hiding the popup.
  if (!ctx) return { open: hasItems, close, step: 1, total: 1 };

  const total = ctx.all.length;
  const step = Math.max(1, ctx.all.indexOf(id) + 1);

  return { open: ctx.active === id, close, step, total };
}
