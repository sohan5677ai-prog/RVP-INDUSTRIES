import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Party, Purchase, Payment } from '@/lib/types';
import { rupees, shortDate, toTonnes } from '@/lib/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TrendingDown, Loader2 } from 'lucide-react';

type PurchaseRow = Purchase & {
  stockIn?: {
    lorryNumber: string;
    invoiceNumber: string;
    purchaseOrder: {
      partyId: string;
    };
  };
};

export default function PurchaseDuesPage() {
  const { data: parties, isLoading: loadingParties } = useQuery({
    queryKey: ['parties'],
    queryFn: () => api<Party[]>('/parties'),
  });

  const { data: purchases, isLoading: loadingPurchases } = useQuery({
    queryKey: ['purchases'],
    queryFn: () => api<PurchaseRow[]>('/purchases'),
  });

  const { data: payments, isLoading: loadingPayments } = useQuery({
    queryKey: ['payments'],
    queryFn: () => api<Payment[]>('/payments'),
  });

  const isLoading = loadingParties || loadingPurchases || loadingPayments;

  const suppliers = parties?.filter((p) => p.type !== 'BUYER') ?? [];

  // Calculate flat list of outstanding purchases using FIFO allocation
  const outstandingPurchases: Array<{
    id: string;
    purchaseDate: Date;
    partyName: string;
    invoiceNumber: string | null;
    pricePerKg: string;
    tonnageKg: number;
    lorryNumber: string | null;
    dueAge: number;
    amount: number;
    totalAmount: number;
    status: string;
  }> = [];

  let totalBillingAll = 0;
  let totalPaymentsAll = 0;

  suppliers.forEach((s) => {
    // 1. Get all verified purchases, sorted oldest first
    const activePurchases = purchases?.filter(
      (p) => p.stockIn?.purchaseOrder?.partyId === s.id && p.verification
    )
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .map((p) => {
        const total = p.verification ? Number(p.verification.totalAmount) : 0;
        return {
          ...p,
          totalAmount: total,
          remainingAmount: total,
        };
      }) ?? [];

    activePurchases.forEach((p) => {
      totalBillingAll += p.totalAmount;
    });

    // 2. Fetch payments made to this supplier
    const partyPayments = payments?.filter((p) => p.type === 'SUPPLIER' && p.partyId === s.id) ?? [];
    const totalPaid = partyPayments.reduce((sum, p) => sum + Number(p.amount), 0);
    totalPaymentsAll += totalPaid;

    let unallocatedPayments = totalPaid;

    // 3. FIFO Allocation
    activePurchases.forEach((p) => {
      if (unallocatedPayments > 0) {
        if (unallocatedPayments >= p.remainingAmount) {
          unallocatedPayments -= p.remainingAmount;
          p.remainingAmount = 0;
        } else {
          p.remainingAmount -= unallocatedPayments;
          unallocatedPayments = 0;
        }
      }
    });

    // 4. Push all items to flat list with status
    const today = new Date();
    activePurchases.forEach((p) => {
      let status = 'Unpaid';
      if (p.remainingAmount <= 0.01) status = 'Paid';
      else if (p.remainingAmount < p.totalAmount - 0.01) status = 'Partially Paid';

      const purchaseDate = new Date(p.createdAt);

        // Calculate age
        const diffTime = today.getTime() - purchaseDate.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        const dueAge = diffDays > 0 ? diffDays : 0;

        outstandingPurchases.push({
          id: p.id,
          purchaseDate,
          partyName: s.name,
          invoiceNumber: p.stockIn?.invoiceNumber ?? null,
          pricePerKg: p.verification?.pricePerKg ?? p.ratePerKg,
          tonnageKg: p.verification?.finalWeightKg ?? p.verification?.billingWeightKg ?? p.netWeightKg,
          lorryNumber: p.stockIn?.lorryNumber ?? null,
          dueAge,
          amount: p.remainingAmount,
          totalAmount: p.totalAmount,
          status,
        });
    });
  });

  // Sort outstanding list by purchase date (oldest first)
  outstandingPurchases.sort((a, b) => a.purchaseDate.getTime() - b.purchaseDate.getTime());

  const totalOutstanding = outstandingPurchases.reduce((sum, item) => sum + item.amount, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Purchase Dues</h1>
        <p className="text-muted-foreground font-medium">Aging list of outstanding supplier purchases matching payments via FIFO allocation.</p>
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
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Verified Purchases</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{rupees(totalBillingAll)}</div>
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
                <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Net Outstanding Dues</CardTitle>
                <TrendingDown className="h-4 w-4 text-rose-500" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-rose-600 dark:text-rose-400">{rupees(totalOutstanding)}</div>
              </CardContent>
            </Card>
          </div>

          <div className="rounded-lg border bg-card [&_div[data-slot=table-container]]:overflow-auto [&_div[data-slot=table-container]]:max-h-[70vh]">
            <div className="px-5 py-4 border-b font-semibold text-sm">Purchase Aging List</div>
            <Table>
              <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-muted [&_th]:shadow-[0_1px_0_0] [&_th]:shadow-border">
                <TableRow>
                  <TableHead>Date (Purchased)</TableHead>
                  <TableHead>Party (Supplier)</TableHead>
                  <TableHead>Invoice No</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Tonnage</TableHead>
                  <TableHead>Vehicle No</TableHead>
                  <TableHead className="text-right">Outstanding Amount</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  <TableHead className="text-center">Due Age (days)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outstandingPurchases.length === 0 ? (
                  <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">No purchase dues found.</TableCell></TableRow>
                ) : (
                  outstandingPurchases.map((bill) => (
                    <TableRow key={bill.id}>
                      <TableCell className="font-medium">{shortDate(bill.purchaseDate.toISOString())}</TableCell>
                      <TableCell>{bill.partyName}</TableCell>
                      <TableCell className="font-mono text-xs">{bill.invoiceNumber ?? '—'}</TableCell>
                      <TableCell className="text-right">{rupees(bill.pricePerKg)}/kg</TableCell>
                      <TableCell className="text-right font-semibold">{toTonnes(bill.tonnageKg).toFixed(2)} t</TableCell>
                      <TableCell className="font-mono text-xs">{bill.lorryNumber ?? '—'}</TableCell>
                      <TableCell className="text-right font-bold text-rose-600 dark:text-rose-400">
                        {rupees(bill.amount)}
                      </TableCell>
                      <TableCell className="text-center">
                        <span className={`font-semibold ${bill.status === 'Paid' ? 'text-emerald-600 dark:text-emerald-400' : bill.status === 'Unpaid' ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400'}`}>
                          {bill.status}
                        </span>
                      </TableCell>
                      <TableCell className="text-center">
                        {bill.status !== 'Paid' ? (
                          <span className="text-rose-600 dark:text-rose-400 font-bold">{bill.dueAge} days</span>
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
