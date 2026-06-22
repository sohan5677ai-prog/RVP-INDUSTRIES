import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Broker, SaleOrder, Payment } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Handshake, Loader2, TrendingDown } from 'lucide-react';

// Flat ₹2,000 brokerage per sale order with a broker. Payments to the broker are
// allocated FIFO (oldest order first) to derive each order's paid & balance.
const FLAT_BROKERAGE = 2000;

interface LedgerRow {
  id: string;
  brokerId: string;
  brokerName: string;
  date: string;
  invoiceNumber: string | null;
  buyerName: string;
  vehicleNumber: string | null;
  due: number;
  paid: number;
  balance: number;
}

export default function BrokerageLedger() {
  const [brokerFilter, setBrokerFilter] = useState<string>('ALL');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');

  const { data: brokers, isLoading: loadingBrokers } = useQuery({
    queryKey: ['brokers'],
    queryFn: () => api<Broker[]>('/brokers'),
  });
  const { data: saleOrders, isLoading: loadingSales } = useQuery({
    queryKey: ['sale-orders'],
    queryFn: () => api<SaleOrder[]>('/sale-orders'),
  });
  const { data: payments, isLoading: loadingPayments } = useQuery({
    queryKey: ['payments'],
    queryFn: () => api<Payment[]>('/payments'),
  });

  const isLoading = loadingBrokers || loadingSales || loadingPayments;

  const rows: LedgerRow[] = [];
  brokers?.forEach((b) => {
    const activeOrders = (saleOrders ?? [])
      .filter((o) => o.brokerId === b.id && o.status !== 'PENDING')
      .sort((a, c) => new Date(a.saleDate).getTime() - new Date(c.saleDate).getTime());

    const totalPaid = (payments ?? [])
      .filter((p) => p.type === 'BROKER' && p.brokerId === b.id)
      .reduce((sum, p) => sum + Number(p.amount), 0);

    let unallocated = totalPaid;
    activeOrders.forEach((o) => {
      const due = FLAT_BROKERAGE;
      const paid = Math.min(unallocated, due);
      unallocated -= paid;
      rows.push({
        id: o.id,
        brokerId: b.id,
        brokerName: b.name,
        date: o.saleDate,
        invoiceNumber: o.invoiceNumber,
        buyerName: o.buyer?.name ?? '—',
        vehicleNumber: o.vehicleNumber,
        due,
        paid,
        balance: due - paid,
      });
    });
  });

  const filtered = rows
    .filter((r) => {
      if (brokerFilter !== 'ALL' && r.brokerId !== brokerFilter) return false;
      const d = new Date(r.date).toISOString().slice(0, 10);
      if (startDate && d < startDate) return false;
      if (endDate && d > endDate) return false;
      return true;
    })
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const totalDue = filtered.reduce((s, r) => s + r.due, 0);
  const totalPaid = filtered.reduce((s, r) => s + r.paid, 0);
  const totalBalance = filtered.reduce((s, r) => s + r.balance, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Brokerage Ledger</h1>
        <p className="text-muted-foreground">Brokerage due, paid &amp; balance per sale order (₹2,000 flat per order, payments allocated FIFO).</p>
      </div>

      {/* Filters Bar */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 bg-muted/40 p-4 rounded-lg border">
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold">Filter by Broker</Label>
          <Select value={brokerFilter} onValueChange={setBrokerFilter}>
            <SelectTrigger className="bg-card"><SelectValue placeholder="All Brokers" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Brokers</SelectItem>
              {brokers?.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
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
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card className="bg-card/50 border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Brokerage Due</CardTitle>
              </CardHeader>
              <CardContent><div className="text-2xl font-bold">{rupees(totalDue)}</div></CardContent>
            </Card>
            <Card className="bg-card/50 border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Paid</CardTitle>
              </CardHeader>
              <CardContent><div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{rupees(totalPaid)}</div></CardContent>
            </Card>
            <Card className="bg-card/50 border shadow-sm">
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Balance Payable</CardTitle>
                <TrendingDown className="h-4 w-4 text-rose-500" />
              </CardHeader>
              <CardContent><div className="text-2xl font-bold text-rose-600 dark:text-rose-400">{rupees(totalBalance)}</div></CardContent>
            </Card>
          </div>

          <div className="rounded-lg border bg-card overflow-x-auto">
            <div className="px-5 py-4 border-b font-semibold text-sm flex items-center gap-2">
              <Handshake className="h-4 w-4 text-primary" /> Brokerage Statement
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Invoice Number</TableHead>
                  <TableHead>Broker</TableHead>
                  <TableHead>Party (Buyer)</TableHead>
                  <TableHead>Vehicle No</TableHead>
                  <TableHead className="text-right">Brokerage Due</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No brokerage entries match selected filters.</TableCell></TableRow>
                ) : (
                  filtered.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{shortDate(r.date)}</TableCell>
                      <TableCell className="font-mono text-xs">{r.invoiceNumber ?? '—'}</TableCell>
                      <TableCell className="font-semibold">{r.brokerName}</TableCell>
                      <TableCell>{r.buyerName}</TableCell>
                      <TableCell className="font-mono text-xs">{r.vehicleNumber ?? '—'}</TableCell>
                      <TableCell className="text-right font-medium">{rupees(r.due)}</TableCell>
                      <TableCell className="text-right text-emerald-600 dark:text-emerald-400">{rupees(r.paid)}</TableCell>
                      <TableCell className={`text-right font-bold ${r.balance > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{rupees(r.balance)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
