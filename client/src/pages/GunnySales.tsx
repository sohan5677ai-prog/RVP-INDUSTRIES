import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { PackageCheck, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { rupees, shortDate } from '@/lib/format';
import { StatCard } from '@/components/StatCard';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ExportButtons } from '@/components/ExportButtons';
import type { ExportColumn } from '@/lib/export';

interface GunnyBagEntry {
  id: string;
  date: string;
  direction: 'PURCHASE' | 'SALE';
  quantity: number;
  amount: string;
  note: string | null;
}

const GUNNY_SALES_COLUMNS: ExportColumn<GunnyBagEntry>[] = [
  { header: 'Date', value: (r) => shortDate(r.date) },
  { header: 'Bags', value: (r) => r.quantity, numFmt: '#,##0', align: 'right' },
  { header: 'Amount', value: (r) => rupees(r.amount), excel: (r) => Number(r.amount), numFmt: '#,##0.00', align: 'right' },
  { header: 'Note', value: (r) => r.note ?? '' },
];

// Read-only income view of the gunny bag SALE side (recorded on the Feroz
// Ledger, in the Expenses tab). Sales are booked as their own income stream —
// not netted against purchase cost — feeding the husk pool and the P&L.
export default function GunnySales() {
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['gunny-bags'],
    queryFn: () => api<GunnyBagEntry[]>('/gunny-bags'),
  });

  const sold = rows.filter((r) => r.direction === 'SALE').sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const total = sold.reduce((s, r) => s + Number(r.amount), 0);
  const bags = sold.reduce((s, r) => s + r.quantity, 0);

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Gunny (bardana) bags sold — booked as Gunny Bag Sales income. Recorded on the{' '}
          <Link to="/reports/gunny-bags" className="underline underline-offset-2 hover:text-foreground">Feroz Ledger</Link> in the Expenses tab.
        </p>
        <ExportButtons filename="Gunny_Sales" title="Gunny Bag Sales" subtitle={`${sold.length} entry(s)`} columns={GUNNY_SALES_COLUMNS} rows={sold} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatCard label="Gunny bag sales income" value={rupees(total)} icon={PackageCheck} tone="forest" hint={`${bags} bags sold`} />
        <StatCard label="Entries" value={sold.length} icon={PackageCheck} tone="amber" hint="sale transactions" />
      </div>

      <div className="rounded-lg border bg-card overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Bags</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Note</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8"><Loader2 className="h-6 w-6 animate-spin text-primary inline" /></TableCell></TableRow>
            ) : sold.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-8">No gunny bag sales yet.</TableCell></TableRow>
            ) : sold.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{shortDate(r.date)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{r.quantity.toLocaleString('en-IN')}</TableCell>
                <TableCell className="text-right font-mono tabular-nums text-emerald-600 dark:text-emerald-400">{rupees(r.amount)}</TableCell>
                <TableCell className="text-muted-foreground">{r.note ?? '-'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
