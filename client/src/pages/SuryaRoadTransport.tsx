import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { SaleOrder, CompanyProfile } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Truck, Wallet, Hourglass } from 'lucide-react';

// Per-trip freight retention (default ₹3,000) held back from each sale's lorry
// freight at dispatch and released to Surya Road Transport when the order is
// delivered (buyer's kata slip in). Mirrors GL accounts 20260 → 20255.
interface RetentionRow {
  id: string;
  date: string;
  buyer: string;
  lorryNumber: string | null;
  invoice: string | null;
  destination: string | null;
  amount: number;
  released: boolean;
}

export default function SuryaRoadTransport() {
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');

  const { data: saleOrders, isLoading } = useQuery({
    queryKey: ['sale-orders'],
    queryFn: () => api<SaleOrder[]>('/sale-orders'),
  });

  const { data: company } = useQuery({
    queryKey: ['company'],
    queryFn: () => api<CompanyProfile>('/settings/company'),
  });

  const retention = Number(company?.freightRetentionPerTrip ?? 3000);

  const rows: RetentionRow[] = (saleOrders ?? [])
    .filter((o) => Number(o.freightCharge) > 0 && o.status !== 'PENDING')
    .map((o) => ({
      id: o.id,
      date: o.saleDate,
      buyer: o.buyer?.name ?? '—',
      lorryNumber: o.vehicleNumber ?? null,
      invoice: o.invoiceNumber ?? null,
      destination: o.destination ?? null,
      amount: retention,
      released: o.status === 'DELIVERED',
    }))
    .filter((r) => {
      const d = new Date(r.date).toISOString().slice(0, 10);
      if (startDate && d < startDate) return false;
      if (endDate && d > endDate) return false;
      return true;
    })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const totalReleased = rows.filter((r) => r.released).reduce((s, r) => s + r.amount, 0);
  const totalHeld = rows.filter((r) => !r.released).reduce((s, r) => s + r.amount, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Surya Road Transport Ledger</h1>
        <p className="text-muted-foreground">Per-trip freight retention held at dispatch and released to Surya on delivery</p>
      </div>

      {/* Filters Bar */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-muted/40 p-4 rounded-lg border">
        <div className="space-y-1.5">
          <Label htmlFor="start" className="text-xs font-semibold">From Date</Label>
          <Input id="start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="bg-card" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="end" className="text-xs font-semibold">To Date</Label>
          <Input id="end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="bg-card" />
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <div className="grid gap-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card className="bg-card border shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Released to Surya (Payable)</CardTitle>
                <Wallet className="h-4 w-4 text-emerald-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{rupees(totalReleased)}</div>
                <p className="text-[10px] text-muted-foreground mt-1">Delivered trips · owed to Surya Road Transport</p>
              </CardContent>
            </Card>
            <Card className="bg-card border shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Retention Held</CardTitle>
                <Hourglass className="h-4 w-4 text-amber-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">{rupees(totalHeld)}</div>
                <p className="text-[10px] text-muted-foreground mt-1">Dispatched but not yet delivered</p>
              </CardContent>
            </Card>
            <Card className="bg-card border shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Trips</CardTitle>
                <Truck className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{rows.length} trips</div>
                <p className="text-[10px] text-muted-foreground mt-1">@ {rupees(retention)} retention per trip</p>
              </CardContent>
            </Card>
          </div>

          {/* Ledger Table */}
          <div className="rounded-lg border bg-card">
            <div className="px-5 py-4 border-b font-semibold text-sm">Freight Retention Movements</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Buyer</TableHead>
                  <TableHead>Lorry No</TableHead>
                  <TableHead>Invoice No</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead className="text-right">Retention</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                      No freight retention entries match selected filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{shortDate(r.date)}</TableCell>
                      <TableCell className="font-semibold">{r.buyer}</TableCell>
                      <TableCell className="font-mono text-sm">{r.lorryNumber ?? '—'}</TableCell>
                      <TableCell className="font-mono text-xs">{r.invoice ?? '—'}</TableCell>
                      <TableCell>{r.destination ?? '—'}</TableCell>
                      <TableCell className="text-right font-bold text-primary">{rupees(r.amount)}</TableCell>
                      <TableCell>
                        <Badge variant={r.released ? 'default' : 'outline'} className="text-[10px]">
                          {r.released ? 'Released to Surya' : 'Held'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
