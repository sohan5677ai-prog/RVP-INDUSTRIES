import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Broker, SaleOrder, Payment } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Handshake, Loader2 } from 'lucide-react';

export default function BrokerageDuesPage() {
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

  // Calculate flat list of outstanding brokerage orders using FIFO allocation
  const outstandingBrokerage: Array<{
    id: string;
    brokerName: string;
    saleDate: string;
    invoiceNumber: string | null;
    buyerName: string;
    vehicleNumber: string | null;
    brokerageAmount: number;
  }> = [];

  let totalEarnedAll = 0;
  let totalPaymentsAll = 0;

  brokers?.forEach((b) => {
    // 1. Get all dispatched/reached orders with this broker, sorted oldest first
    const activeOrders = saleOrders?.filter((o) => o.brokerId === b.id && o.status !== 'PENDING')
      .sort((a, b) => new Date(a.saleDate).getTime() - new Date(b.saleDate).getTime())
      .map((o) => {
        // Flat ₹2000 brokerage per order as requested
        return {
          ...o,
          totalBrokerage: 2000,
          remainingBrokerage: 2000,
        };
      }) ?? [];

    activeOrders.forEach((o) => {
      totalEarnedAll += o.totalBrokerage;
    });

    // 2. Fetch payments made to this broker
    const brokerPayments = payments?.filter((p) => p.type === 'BROKER' && p.brokerId === b.id) ?? [];
    const totalPaid = brokerPayments.reduce((sum, p) => sum + Number(p.amount), 0);
    totalPaymentsAll += totalPaid;

    let unallocatedPayments = totalPaid;

    // 3. FIFO Allocation
    activeOrders.forEach((o) => {
      if (unallocatedPayments > 0) {
        if (unallocatedPayments >= o.remainingBrokerage) {
          unallocatedPayments -= o.remainingBrokerage;
          o.remainingBrokerage = 0;
        } else {
          o.remainingBrokerage -= unallocatedPayments;
          unallocatedPayments = 0;
        }
      }
    });

    // 4. Push outstanding items to flat list
    activeOrders.forEach((o) => {
      if (o.remainingBrokerage > 0.01) { // ignore floating point dust
        outstandingBrokerage.push({
          id: o.id,
          brokerName: b.name,
          saleDate: o.saleDate,
          invoiceNumber: o.invoiceNumber,
          buyerName: o.buyer?.name ?? '—',
          vehicleNumber: o.vehicleNumber,
          brokerageAmount: o.remainingBrokerage,
        });
      }
    });
  });

  // Sort outstanding list by sale date (oldest first)
  outstandingBrokerage.sort((a, b) => new Date(a.saleDate).getTime() - new Date(b.saleDate).getTime());

  const totalOutstanding = outstandingBrokerage.reduce((sum, item) => sum + item.brokerageAmount, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Brokerage Dues</h1>
        <p className="text-muted-foreground font-medium">Outstanding commissions list displaying ₹2,000 flat fee per sale order matched with payments via FIFO.</p>
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
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Brokerage Earned</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{rupees(totalEarnedAll)}</div>
              </CardContent>
            </Card>
            <Card className="bg-card/50 border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Payments Made</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{rupees(totalPaymentsAll)}</div>
              </CardContent>
            </Card>
            <Card className="bg-card/50 border shadow-sm">
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Net Outstanding Payable</CardTitle>
                <Handshake className="h-4 w-4 text-rose-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-rose-600 dark:text-rose-400">{rupees(totalOutstanding)}</div>
              </CardContent>
            </Card>
          </div>

          <div className="rounded-lg border bg-card">
            <div className="px-5 py-4 border-b font-semibold text-sm">Outstanding Brokerage Dues List</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Broker</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Invoice Number</TableHead>
                  <TableHead>Party (Buyer)</TableHead>
                  <TableHead>Vehicle No</TableHead>
                  <TableHead className="text-right">Brokerage Due</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outstandingBrokerage.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No outstanding brokerage dues.</TableCell></TableRow>
                ) : (
                  outstandingBrokerage.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="font-semibold">{o.brokerName}</TableCell>
                      <TableCell>{shortDate(o.saleDate)}</TableCell>
                      <TableCell className="font-mono text-xs">{o.invoiceNumber ?? '—'}</TableCell>
                      <TableCell>{o.buyerName}</TableCell>
                      <TableCell className="font-mono text-xs">{o.vehicleNumber ?? '—'}</TableCell>
                      <TableCell className="text-right font-bold text-rose-600 dark:text-rose-400">
                        {rupees(o.brokerageAmount)}
                      </TableCell>
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
