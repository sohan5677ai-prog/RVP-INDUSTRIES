import { useMemo } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export interface Period {
  from: string; // ISO date (start of day)
  to: string;   // ISO date (end of day)
  label: string;
}

const MONTHS = [
  'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar',
];

/** The FY (start calendar year) that a date falls in — FY runs Apr–Mar. */
function fyStartYear(d: Date): number {
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
}

/** Label like "2026-27" for an FY start year. */
export function fyLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Compute the ISO window for an FY (+ optional month index 0=Apr … 11=Mar). */
export function periodFor(startYear: number, monthIdx: number | 'ALL'): Period {
  if (monthIdx === 'ALL') {
    return {
      from: new Date(startYear, 3, 1).toISOString(),
      to: new Date(startYear + 1, 2, 31, 23, 59, 59, 999).toISOString(),
      label: `FY ${fyLabel(startYear)}`,
    };
  }
  // Apr(3)…Dec(11) sit in startYear; Jan(0)…Mar(2) roll into startYear+1.
  const calMonth = (monthIdx + 3) % 12;
  const calYear = monthIdx <= 8 ? startYear : startYear + 1;
  const from = new Date(calYear, calMonth, 1);
  const to = new Date(calYear, calMonth + 1, 0, 23, 59, 59, 999); // last day of month
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    label: `${MONTHS[monthIdx]} ${calYear} · FY ${fyLabel(startYear)}`,
  };
}

interface PeriodFilterProps {
  fy: number;                       // FY start year
  month: number | 'ALL';            // 0=Apr … 11=Mar, or 'ALL'
  onFyChange: (fy: number) => void;
  onMonthChange: (m: number | 'ALL') => void;
}

/** FY + month selector used by the statutory reports. */
export function PeriodFilter({ fy, month, onFyChange, onMonthChange }: PeriodFilterProps) {
  const fyOptions = useMemo(() => {
    const current = fyStartYear(new Date());
    // Current FY plus the four prior years.
    return Array.from({ length: 5 }, (_, i) => current - i);
  }, []);

  return (
    <div className="flex items-center gap-2">
      <Select value={String(fy)} onValueChange={(v) => onFyChange(Number(v))}>
        <SelectTrigger size="sm" className="min-w-[8.5rem]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {fyOptions.map((y) => (
            <SelectItem key={y} value={String(y)}>Financial Year {fyLabel(y)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={String(month)} onValueChange={(v) => onMonthChange(v === 'ALL' ? 'ALL' : Number(v))}>
        <SelectTrigger size="sm" className="min-w-[7rem]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ALL">Full Year</SelectItem>
          {MONTHS.map((m, i) => (
            <SelectItem key={m} value={String(i)}>{m}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
