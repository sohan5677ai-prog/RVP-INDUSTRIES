// Cached formatters — avoids re-constructing Intl.NumberFormat on every call
// (significant in tables with 100+ rows × multiple columns).
const inFmt = new Intl.NumberFormat('en-IN');
const inrFmt = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
});
const inrShortFmt = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/** Format kg as a readable string. */
export function kg(value: number | null | undefined): string {
  if (value == null) return '-';
  return `${inFmt.format(value)} kg`;
}

/** kg -> tonnes (number). */
export function toTonnes(kgValue: number): number {
  return kgValue / 1000;
}

/** Format rupees (accepts number or Decimal-string). */
export function rupees(value: number | string | null | undefined): string {
  if (value == null) return '-';
  const n = typeof value === 'string' ? Number(value) : value;
  return inrFmt.format(n);
}

/** Format rupees using Indian abbreviations (Lakhs, Crores) for large numbers. */
export function rupeesShort(value: number | string | null | undefined): string {
  if (value == null) return '-';
  const n = typeof value === 'string' ? Number(value) : value;
  
  if (n >= 10000000) {
    return `₹${(n / 10000000).toFixed(2)} Cr`;
  }
  if (n >= 100000) {
    return `₹${(n / 100000).toFixed(2)} L`;
  }
  return inrShortFmt.format(n);
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Collapsed PO-group label, e.g. a 6-lorry DCS batch -> "DCS/01-06/26-27".
 * Falls back to joining the raw poNumbers when the series fields are missing
 * (legacy POs created before the nickname-based numbering scheme).
 */
export function formatPoGroupLabel(
  pos: { poNumber: string; poSeriesKey?: string | null; poSerial?: number | null; poFy?: string | null }[]
): string {
  const first = pos[0]?.poNumber ?? '';
  const last = pos[pos.length - 1]?.poNumber ?? '';
  if (pos.length <= 1) return first;

  const hasSeries = pos.every((p) => p.poSeriesKey && p.poFy && typeof p.poSerial === 'number');
  if (!hasSeries) return `${first} – ${last}`;

  const key = pos[0].poSeriesKey!;
  const fy = pos[0].poFy!;
  const serials = pos.map((p) => p.poSerial!);
  const min = Math.min(...serials);
  const max = Math.max(...serials);
  const pad = (n: number) => String(n).padStart(2, '0');
  return min === max ? `${key}/${pad(min)}/${fy}` : `${key}/${pad(min)}-${pad(max)}/${fy}`;
}

