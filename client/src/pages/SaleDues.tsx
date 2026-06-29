import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Party, SaleOrder, Receipt } from '@/lib/types';
import { rupees, shortDate } from '@/lib/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TrendingUp, Loader2 } from 'lucide-react';

export default function SaleDuesPage() {
  const { data: parties, isLoading: loadingParties } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const { data: saleOrders, isLoading: loadingSales } = useQuery({
    queryKey: ['sale-orders'],
    queryFn: () => api<SaleOrder[]>('/sale-orders'),
  });

  const { data: receipts, isLoading: loadingReceipts } = useQuery({
    queryKey: ['receipts'],
    queryFn: () => api<Receipt[]>('/receipts'),
  });

  const isLoading = loadingParties || loadingSales || loadingReceipts;

  const buyers = parties?.filter((p) => p.type === 'BUYER') ?? [];

  // Calculate flat list of outstanding invoices using FIFO allocation
  const outstandingInvoices: Array<{
    id: string;
    brokerName: string | null;
    dueDate: Date;
    partyName: string;
    invoiceNumber: string | null;
    billDate: Date;
    billAmount: number;
    shortage: number;
    discount: number;
    netAmount: number;
    totalAmount: number;
    dueDaysAfter: number;
    status: string;
  }> = [];

  let totalBillingAll = 0;
  let totalReceiptsAll = 0;

  buyers.forEach((b) => {
    // 1. Each dispatch (shipment) is a billed invoice line. Gather them across the
    //    buyer's orders, sorted oldest first.
    const shipments = (saleOrders ?? [])
      .filter((o) => o.buyerId === b.id)
      .flatMap((o) => (o.dispatches ?? []).map((d) => ({ d, o })))
      .sort((a, z) => new Date(a.d.dispatchDate).getTime() - new Date(z.d.dispatchDate).getTime())
      .map(({ d, o }) => {
        const base = Number(d.weightKg) * Number(o.ratePerKg);
        const gst = Number(d.gstAmount) || 0;
        const cn = Number(d.creditNoteAmount) || 0;
        const total = base + gst;
        return { d, o, billAmount: base + gst, totalAmount: total, remainingAmount: total };
      });

    shipments.forEach((s) => {
      totalBillingAll += s.totalAmount;
    });

    // 2. Fetch receipts for this buyer
    const buyerReceipts = receipts?.filter((r) => r.type === 'BUYER' && r.partyId === b.id) ?? [];
    const totalCollected = buyerReceipts.reduce((sum, r) => sum + Number(r.amount), 0);
    totalReceiptsAll += totalCollected;

    let unallocatedReceipts = totalCollected;

    // 3. FIFO Allocation
    shipments.forEach((s) => {
      if (unallocatedReceipts > 0) {
        if (unallocatedReceipts >= s.remainingAmount) {
          unallocatedReceipts -= s.remainingAmount;
          s.remainingAmount = 0;
        } else {
          s.remainingAmount -= unallocatedReceipts;
          unallocatedReceipts = 0;
        }
      }
    });

    // 4. Push all items to flat list with status
    const today = new Date();
    shipments.forEach((s) => {
      let status = 'Unpaid';
      if (s.remainingAmount <= 0.01) status = 'Paid';
      else if (s.remainingAmount < s.totalAmount - 0.01) status = 'Partially Paid';

      const start = s.d.deliveredDate || s.d.dispatchDate;
      const limitDays = s.o.dueDays || 0;
      const dueDate = new Date(start);
      dueDate.setDate(dueDate.getDate() + limitDays);

      // Calculate days overdue
      const diffTime = today.getTime() - dueDate.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      const dueDaysAfter = diffDays > 0 ? diffDays : 0;

      outstandingInvoices.push({
        id: s.d.id,
        brokerName: s.o.broker?.name ?? null,
        dueDate,
        partyName: b.name,
        invoiceNumber: s.d.invoiceNumber,
        billDate: new Date(s.d.dispatchDate),
        billAmount: s.billAmount,
        discount: 0,
        netAmount: s.remainingAmount,
        totalAmount: s.totalAmount,
        dueDaysAfter,
        status,
      });
    });
  });

  // Sort outstanding list by due date (oldest due date first)
  outstandingInvoices.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

  const totalOutstanding = outstandingInvoices.reduce((sum, item) => sum + item.netAmount, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Sale Dues</h1>
        <p className="text-muted-foreground font-medium">Aging list of outstanding buyer sales invoices matching receipts via FIFO allocation.</p>
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
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Billed Sales</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{rupees(totalBillingAll)}</div>
              </CardContent>
            </Card>
            <Card className="bg-card/50 border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Collections Received</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{rupees(totalReceiptsAll)}</div>
              </CardContent>
            </Card>
            <Card className="bg-card/50 border shadow-sm">
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Net Outstanding Receivables</CardTitle>
                <TrendingUp className="h-4 w-4 text-emerald-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{rupees(totalOutstanding)}</div>
              </CardContent>
            </Card>
          </div>

          <div className="rounded-lg border bg-card">
            <div className="px-5 py-4 border-b font-semibold text-sm">Sales Aging List</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Broker</TableHead>
                  <TableHead>Due Date</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Invoice No</TableHead>
                  <TableHead>Bill Date</TableHead>
                  <TableHead className="text-right">Bill Amount</TableHead>
                  <TableHead className="text-right">Discount</TableHead>
                  <TableHead className="text-right">Net Amount</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  <TableHead className="text-center">Due Days</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outstandingInvoices.length === 0 ? (
                  <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground py-8">No sales dues found.</TableCell></TableRow>
                ) : (
                  outstandingInvoices.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell>{inv.brokerName ?? '—'}</TableCell>
                      <TableCell className="font-medium">{shortDate(inv.dueDate.toISOString())}</TableCell>
                      <TableCell>{inv.partyName}</TableCell>
                      <TableCell className="font-mono text-xs">{inv.invoiceNumber ?? '—'}</TableCell>
                      <TableCell>{shortDate(inv.billDate.toISOString())}</TableCell>
                      <TableCell className="text-right">{rupees(inv.billAmount)}</TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {inv.discount > 0 ? `−${rupees(inv.discount)}` : '—'}
                      </TableCell>
                      <TableCell className="text-right font-bold text-emerald-600 dark:text-emerald-400">
                        {rupees(inv.netAmount)}
                      </TableCell>
                      <TableCell className="text-center">
                        <span className={`font-semibold ${inv.status === 'Paid' ? 'text-emerald-600 dark:text-emerald-400' : inv.status === 'Unpaid' ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400'}`}>
                          {inv.status}
                        </span>
                      </TableCell>
                      <TableCell className="text-center">
                        {inv.status !== 'Paid' ? (
                          inv.dueDaysAfter > 0 ? (
                            <span className="text-rose-600 dark:text-rose-400 font-bold">{inv.dueDaysAfter} days</span>
                          ) : (
                            <span className="text-muted-foreground">Not due</span>
                          )
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
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
