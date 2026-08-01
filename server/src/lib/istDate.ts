/**
 * India-fixed date handling.
 *
 * Every date this ERP derives or prints — invoice and PO numbers, e-way bills,
 * statements, WhatsApp and Slack messages — is an IST business date. But
 * `getDate()`/`getHours()` and a bare `toLocaleDateString()` read the *process*
 * clock, which is IST on the office machines and UTC on Render. That 5:30 gap
 * printed e-way bills 5½ hours early, and can push any midnight-IST timestamp
 * onto the previous calendar day.
 *
 * Derive and format through these helpers (or pass `timeZone: IST_TZ`) so the
 * output is identical wherever the server happens to run.
 */
export const IST_TZ = 'Asia/Kolkata';

/** Zero-padded calendar/clock parts of an instant, as seen in IST. */
export function istParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
  }).formatToParts(new Date(date));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    day: get('day'), month: get('month'), year: get('year'),
    hour: get('hour').padStart(2, '0'), minute: get('minute'), second: get('second'),
    ampm: (get('dayPeriod') || 'AM').replace(/\./g, '').toUpperCase(),
  };
}

/** Numeric IST calendar fields. `month` is 1-based, so April is 4. */
export function istCalendar(date: Date): { year: number; month: number; day: number } {
  const p = istParts(date);
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day) };
}

/** Start year of the Indian financial year (Apr–Mar) an instant falls in. */
export function istFinancialYearStart(date: Date): number {
  const { year, month } = istCalendar(date);
  return month >= 4 ? year : year - 1;
}
