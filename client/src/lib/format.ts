/** Format kg as a readable string. */
export function kg(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${value.toLocaleString('en-IN')} kg`;
}

/** kg -> tonnes (number). */
export function toTonnes(kgValue: number): number {
  return kgValue / 1000;
}

/** Format rupees (accepts number or Decimal-string). */
export function rupees(value: number | string | null | undefined): string {
  if (value == null) return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(n);
}

/** Format rupees using Indian abbreviations (Lakhs, Crores) for large numbers. */
export function rupeesShort(value: number | string | null | undefined): string {
  if (value == null) return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  
  if (n >= 10000000) {
    return `₹${(n / 10000000).toFixed(2)} Cr`;
  }
  if (n >= 100000) {
    return `₹${(n / 100000).toFixed(2)} L`;
  }
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(n);
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}
