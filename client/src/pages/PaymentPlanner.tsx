import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Party, Purchase, Payment } from '@/lib/types';
import { rupees, shortDate, toTonnes } from '@/lib/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Wallet, Loader2 } from 'lucide-react';

type PurchaseRow = Purchase & {
  stockIn?: {
    arrivalDate?: string;
    lorryNumber: string;
    invoiceNumber: string;
    purchaseOrder: {
      partyId: string;
    };
  };
};

interface OutstandingPurchase {
  id: string;
  partyId: string;
  purchaseDate: Date;
  partyName: string;
  invoiceNumber: string | null;
  pricePerKg: string;
  tonnageKg: number;
  lorryNumber: string | null;
  dueAge: number;
  amount: number;
}

export default function PaymentPlannerPage() {
  const [bankBalance, setBankBalance] = useState('');
  const [plans, setPlans] = useState<Record<string, string>>({});

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

  const outstandingPurchases: OutstandingPurchase[] = [];

  suppliers.forEach((s) => {
    const activePurchases = purchases?.filter(
      (p) => p.stockIn?.purchaseOrder?.partyId === s.id && p.verification
    )
      .sort((a, b) => {
        const dateA = new Date(a.stockIn?.arrivalDate || a.createdAt).getTime();
        const dateB = new Date(b.stockIn?.arrivalDate || b.createdAt).getTime();
        return dateA - dateB;
      })
      .map((p) => {
        const total = p.verification ? Math.round(Number(p.verification.totalAmount)) : 0;
        return { ...p, totalAmount: total, remainingAmount: total };
      }) ?? [];

    const partyPayments = payments?.filter((p) => p.type === 'SUPPLIER' && p.partyId === s.id)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()) ?? [];

    const availablePayments = partyPayments.map((p) => ({ ...p, available: Number(p.amount) }));

    activePurchases.forEach((p) => {
      for (const payment of availablePayments) {
        if (p.remainingAmount <= 0) break;
        if (payment.available > 0) {
          const applied = Math.min(payment.available, p.remainingAmount);
          payment.available -= applied;
          p.remainingAmount -= applied;
        }
      }
    });

    const today = new Date();
    activePurchases.forEach((p) => {
      if (p.remainingAmount <= 0.01) return; // only unpaid / partially paid bills matter here

      const purchaseDate = new Date(p.stockIn?.arrivalDate || p.createdAt);
      const diffTime = today.getTime() - purchaseDate.getTime();
      const dueAge = Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));

      outstandingPurchases.push({
        id: p.id,
        partyId: s.id,
        purchaseDate,
        partyName: s.name,
        invoiceNumber: p.stockIn?.invoiceNumber ?? null,
        pricePerKg: p.verification?.pricePerKg ?? '0',
        tonnageKg: p.verification?.finalWeightKg ?? p.verification?.billingWeightKg ?? p.netWeightKg,
        lorryNumber: p.stockIn?.lorryNumber ?? null,
        dueAge,
        amount: p.remainingAmount,
      });
    });
  });

  // Oldest dues first — pay these before the newer ones.
  outstandingPurchases.sort((a, b) => a.purchaseDate.getTime() - b.purchaseDate.getTime());

  const totalOutstanding = outstandingPurchases.reduce((sum, item) => sum + item.amount, 0);

  const bankNum = parseFloat(bankBalance) || 0;
  const totalPlanned = outstandingPurchases.reduce(
    (sum, item) => sum + (parseFloat(plans[item.id]) || 0),
    0
  );
  const bankAfter = bankNum - totalPlanned;
  const duesAfter = totalOutstanding - totalPlanned;

  function setPlan(id: string, value: string) {
    setPlans((prev) => ({ ...prev, [id]: value }));
  }

  function autoAllocate() {
    // Distribute the current bank balance across the oldest dues first.
    let remaining = bankNum;
    const next: Record<string, string> = {};
    for (const bill of outstandingPurchases) {
      if (remaining <= 0) {
        next[bill.id] = '';
        continue;
      }
      const pay = Math.min(remaining, bill.amount);
      next[bill.id] = pay.toFixed(2);
      remaining -= pay;
    }
    setPlans(next);
  }

  function clearPlan() {
    setPlans({});
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Payment Planner</h1>
        <p className="text-muted-foreground font-medium">Plan supplier payments against your available bank balance. Nothing here is recorded — it is a what-if worksheet.</p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <>
          {/* Bank balance + summary */}
          <Card className="bg-card/50 border shadow-sm">
            <CardHeader className="pb-3 flex flex-row items-center gap-2">
              <Wallet className="h-4 w-4 text-primary" />
              <CardTitle className="text-sm font-semibold">Bank Balance &amp; Plan Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 items-end">
                <div className="space-y-1">
                  <Label htmlFor="bank-balance">Current Bank Balance (₹)</Label>
                  <Input
                    id="bank-balance"
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={bankBalance}
                    onChange={(e) => setBankBalance(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Total Outstanding Dues</Label>
                  <div className="h-10 flex items-center rounded-md border bg-muted/40 px-3 font-bold text-rose-600 dark:text-rose-400">
                    {rupees(totalOutstanding)}
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Total Planned Payment</Label>
                  <div className="h-10 flex items-center rounded-md border bg-muted/40 px-3 font-bold">
                    {rupees(totalPlanned)}
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Balance After Payment</Label>
                  <div className={`h-10 flex items-center rounded-md border px-3 font-bold ${bankAfter < 0 ? 'text-rose-600 dark:text-rose-400 bg-rose-500/10' : 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10'}`}>
                    {rupees(bankAfter)}
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Dues After Payment</Label>
                  <div className="h-10 flex items-center rounded-md border bg-muted/40 px-3 font-bold">
                    {rupees(Math.max(0, duesAfter))}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 mt-4">
                <Button size="sm" variant="outline" onClick={autoAllocate} disabled={bankNum <= 0}>
                  Auto-allocate balance (oldest first)
                </Button>
                <Button size="sm" variant="ghost" onClick={clearPlan}>
                  Clear
                </Button>
                {bankAfter < 0 && (
                  <span className="text-xs text-rose-600 dark:text-rose-400 font-medium ml-auto">
                    Planned payments exceed your bank balance by {rupees(-bankAfter)}.
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Dues table with per-row planning */}
          <div className="rounded-lg border bg-card overflow-auto max-h-[70vh]">
            <div className="px-5 py-4 border-b font-semibold text-sm">Outstanding Purchases</div>
            <Table>
              <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-muted [&_th]:shadow-[0_1px_0_0] [&_th]:shadow-border">
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Party</TableHead>
                  <TableHead>Invoice No</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead>Vehicle No</TableHead>
                  <TableHead className="text-right">Outstanding Amount</TableHead>
                  <TableHead className="text-center">Due Days</TableHead>
                  <TableHead className="text-right w-[160px]">Amount to Pay (₹)</TableHead>
                  <TableHead className="text-right">Remaining After</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outstandingPurchases.length === 0 ? (
                  <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">No outstanding purchase dues.</TableCell></TableRow>
                ) : (
                  outstandingPurchases.map((bill) => {
                    const pay = parseFloat(plans[bill.id]) || 0;
                    const remaining = bill.amount - pay;
                    const overPaid = pay > bill.amount + 0.01;
                    return (
                      <TableRow key={bill.id}>
                        <TableCell className="font-medium whitespace-nowrap">{shortDate(bill.purchaseDate.toISOString())}</TableCell>
                        <TableCell>{bill.partyName}</TableCell>
                        <TableCell className="font-mono text-xs">{bill.invoiceNumber ?? '-'}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          {rupees(bill.pricePerKg)}/kg
                          <span className="text-muted-foreground text-xs block">{toTonnes(bill.tonnageKg).toFixed(2)} t</span>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{bill.lorryNumber ?? '-'}</TableCell>
                        <TableCell className="text-right font-bold text-rose-600 dark:text-rose-400">{rupees(bill.amount)}</TableCell>
                        <TableCell className="text-center">
                          <span className="text-rose-600 dark:text-rose-400 font-bold">{bill.dueAge} days</span>
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder="0.00"
                            value={plans[bill.id] ?? ''}
                            onChange={(e) => setPlan(bill.id, e.target.value)}
                            className={`h-9 text-right ${overPaid ? 'border-rose-500 focus-visible:ring-rose-500' : ''}`}
                          />
                        </TableCell>
                        <TableCell className={`text-right font-semibold ${remaining <= 0.01 ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>
                          {rupees(Math.max(0, remaining))}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
