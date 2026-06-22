/** Indian financial year (Apr–Mar) for a date, e.g. 2026-06 -> "2026-27". */
export function indianFinancialYear(date: Date): string {
  const y = date.getFullYear();
  const startYear = date.getMonth() >= 3 ? y : y - 1; // months are 0-based; Apr = 3
  const endShort = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYear}-${endShort}`;
}

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** Words for a number 0–999. */
function below1000(n: number): string {
  if (n === 0) return '';
  if (n < 20) return ONES[n];
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`;
  return `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ' ' + below1000(n % 100) : ''}`;
}

/** Whole number to Indian-system words (Crore/Lakh/Thousand/Hundred). */
function wholeToWords(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(`${below1000(crore)} Crore`);
  if (lakh) parts.push(`${below1000(lakh)} Lakh`);
  if (thousand) parts.push(`${below1000(thousand)} Thousand`);
  if (n) parts.push(below1000(n));
  return parts.join(' ');
}

/**
 * Format a rupee amount as words, e.g. 1559250 -> "INR Fifteen Lakh Fifty Nine
 * Thousand Two Hundred Fifty Only", including paise when present.
 */
export function rupeesInWords(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  const rupees = Math.floor(rounded);
  const paise = Math.round((rounded - rupees) * 100);
  let words = `INR ${wholeToWords(rupees)}`;
  if (paise > 0) words += ` and ${wholeToWords(paise)} Paise`;
  return `${words} Only`;
}

/** Indian-grouped amount with two decimals, e.g. 1485000 -> "14,85,000.00". */
export function inr(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}
