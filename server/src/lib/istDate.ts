/**
 * India-fixed date handling.
 *
 * Every date this ERP derives or prints - invoice and PO numbers, e-way bills,
 * statements, WhatsApp and Slack messages - is an IST business date. But
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

/** IST is a fixed +05:30 offset with no DST, so the shift is a constant. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * UTC instant of midnight IST on a calendar date. `month` is 1-based, and the
 * usual Date overflow applies, so (2026, 13, 1) is January 2027.
 */
export function istMidnight(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day) - IST_OFFSET_MS);
}

/** Days in a calendar month. `month` is 1-based. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * UTC instants bounding an Indian financial year, as a half-open `[from, to)`.
 *
 * FY 2025-26 -> 2025-03-31T18:30:00Z .. 2026-03-31T18:30:00Z, i.e. midnight IST
 * on 1 April at either end. Half-open so a voucher stamped exactly at midnight
 * on 1 April lands in the new year only, never in both.
 */
export function istFinancialYearRange(fyStart: number): { from: Date; to: Date } {
  const midnightIstOn1April = (year: number) =>
    new Date(Date.UTC(year, 3, 1) - IST_OFFSET_MS);
  return { from: midnightIstOn1April(fyStart), to: midnightIstOn1April(fyStart + 1) };
}

/** Long FY label, e.g. 2025 -> "2025-26". Matches `indianFinancialYear`. */
export function fyLabelLong(fyStart: number): string {
  return `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
}

/** Short FY label, e.g. 2025 -> "25-26". Matches `computeFY` in poNumber.ts. */
export function fyLabelShort(fyStart: number): string {
  const yy = (n: number) => String(n % 100).padStart(2, '0');
  return `${yy(fyStart)}-${yy(fyStart + 1)}`;
}
