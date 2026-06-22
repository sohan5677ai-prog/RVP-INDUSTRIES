/** Small helpers shared by the Slack flows (unit conversion, formatting). */

/** Tonnes → whole kilograms (the ERP stores weights in kg). */
export function tonnesToKg(tonnes: number): number {
  return Math.round(tonnes * 1000);
}

/** Kilograms → tonnes string for display, trimming trailing zeros. */
export function kgToTonnes(kg: number): string {
  return (kg / 1000).toString();
}

/** ₹ formatting with thousands separators (Indian-style grouping is fine here). */
export function rupees(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/** Human-readable date (e.g. "22 Jun 2026") from an ISO/date string. */
export function fmtDate(d: string | Date): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
