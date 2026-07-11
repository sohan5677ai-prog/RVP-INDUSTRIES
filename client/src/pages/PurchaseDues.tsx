import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { Party, Purchase, Payment } from '@/lib/types';
import { rupees, shortDate, toTonnes } from '@/lib/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TrendingDown, Loader2, ChevronDown, ChevronRight, Undo2 } from 'lucide-react';
import { Fragment } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

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
  totalAmount: number;
  status: string;
  appliedPayments: { date: string; amount: number; mode: string }[];
  deletablePaymentIds: string[];
}

interface PayDialogState {
  bill: OutstandingPurchase;
  date: string;
  amount: string;
  mode: string;
}

export default function PurchaseDuesPage() {
  const qc = useQueryClient();
  const [payDialog, setPayDialog] = useState<PayDialogState | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

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

  const payMutation = useMutation({
    mutationFn: (body: { date: string; amount: number; type: string; partyId: string; purchaseId?: string; reference?: string }) =>
      api('/payments', { method: 'POST', body }),
    onSuccess: () => {
      toast.success('Payment recorded');
      qc.invalidateQueries({ queryKey: ['payments'] });
      setPayDialog(null);
    },
    onError: () => toast.error('Failed to record payment'),
  });

  const undoMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) {
        await api(`/payments/${id}`, { method: 'DELETE' });
      }
    },
    onSuccess: () => {
      toast.success('Payment removed');
      qc.invalidateQueries({ queryKey: ['payments'] });
    },
    onError: () => toast.error('Failed to remove payment'),
  });

  const isLoading = loadingParties || loadingPurchases || loadingPayments;

  const suppliers = parties?.filter((p) => p.type !== 'BUYER') ?? [];

  const outstandingPurchases: OutstandingPurchase[] = [];

  let totalBillingAll = 0;
  let totalPaymentsAll = 0;

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
        return {
          ...p,
          totalAmount: total,
          remainingAmount: total,
          appliedPayments: [] as OutstandingPurchase['appliedPayments'],
          deletablePaymentIds: [] as string[],
        };
      }) ?? [];

    activePurchases.forEach((p) => { totalBillingAll += p.totalAmount; });

    const partyPayments = payments?.filter((p) => p.type === 'SUPPLIER' && p.partyId === s.id)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()) ?? [];
    
    const totalPaid = partyPayments.reduce((sum, p) => sum + Number(p.amount), 0);
    totalPaymentsAll += totalPaid;

    // Apply direct payments first
    activePurchases.forEach((p) => {
      const directPayments = partyPayments.filter((pay) => pay.purchaseId === p.id);
      directPayments.forEach((pay) => {
        p.deletablePaymentIds.push(pay.id);
        const amt = Number(pay.amount);
        if (p.remainingAmount > 0) {
          const applied = Math.min(amt, p.remainingAmount);
          p.remainingAmount -= applied;
          p.appliedPayments.push({
            date: pay.date,
            amount: applied,
            mode: pay.reference || 'Manual'
          });
        }
      });
    });

    let availablePayments = partyPayments
      .filter((p) => !p.purchaseId)
      .map(p => ({
        ...p,
        available: Number(p.amount)
      }));

    activePurchases.forEach((p) => {
      for (const payment of availablePayments) {
        if (p.remainingAmount <= 0) break;
        if (payment.available > 0) {
          const applied = Math.min(payment.available, p.remainingAmount);
          payment.available -= applied;
          p.remainingAmount -= applied;

          if (!p.deletablePaymentIds.includes(payment.id)) {
            p.deletablePaymentIds.push(payment.id);
          }

          let mode = payment.reference || 'Manual';

          p.appliedPayments.push({
            date: payment.date,
            amount: applied,
            mode: mode
          });
        }
      }
    });

    const today = new Date();
    activePurchases.forEach((p) => {
      let status = 'Unpaid';
      if (p.remainingAmount <= 0.01) status = 'Paid';
      else if (p.remainingAmount < p.totalAmount - 0.01) status = 'Partially Paid';

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
        totalAmount: p.totalAmount,
        status,
        appliedPayments: p.appliedPayments,
        deletablePaymentIds: p.deletablePaymentIds,
      });
    });
  });

  outstandingPurchases.sort((a, b) => a.purchaseDate.getTime() - b.purchaseDate.getTime());

  const totalOutstanding = outstandingPurchases.reduce((sum, item) => sum + item.amount, 0);

  function openPayDialog(bill: OutstandingPurchase) {
    const today = new Date().toISOString().slice(0, 10);
    setPayDialog({ bill, date: today, amount: bill.amount.toFixed(2), mode: 'NEFT' });
  }

  function submitPay() {
    if (!payDialog) return;
    const amt = parseFloat(payDialog.amount);
    if (!payDialog.date || isNaN(amt) || amt <= 0) {
      toast.error('Please enter a valid date and amount');
      return;
    }
    payMutation.mutate({
      date: payDialog.date,
      amount: amt,
      type: 'SUPPLIER',
      partyId: payDialog.bill.partyId,
      purchaseId: payDialog.bill.id,
      reference: payDialog.mode,
    });
  }

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

          <div className="rounded-lg border bg-card overflow-auto max-h-[70vh]">
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
                  <TableHead className="text-center">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outstandingPurchases.length === 0 ? (
                  <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground py-8">No purchase dues found.</TableCell></TableRow>
                ) : (
                  outstandingPurchases.map((bill) => (
                    <Fragment key={bill.id}>
                      <TableRow className="cursor-pointer hover:bg-muted/50" onClick={() => setExpandedId(expandedId === bill.id ? null : bill.id)}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            {expandedId === bill.id ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                            {shortDate(bill.purchaseDate.toISOString())}
                          </div>
                        </TableCell>
                        <TableCell>{bill.partyName}</TableCell>
                        <TableCell className="font-mono text-xs">{bill.invoiceNumber ?? '-'}</TableCell>
                        <TableCell className="text-right">{rupees(bill.pricePerKg)}/kg</TableCell>
                        <TableCell className="text-right font-semibold">{toTonnes(bill.tonnageKg).toFixed(2)} t</TableCell>
                        <TableCell className="font-mono text-xs">{bill.lorryNumber ?? '-'}</TableCell>
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
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell className="text-center">
                          <div className="flex items-center justify-center gap-2">
                            {bill.status !== 'Paid' && (
                              <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); openPayDialog(bill); }}>
                                Paid
                              </Button>
                            )}
                            {bill.deletablePaymentIds.length > 0 && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-rose-600 hover:text-rose-700 dark:text-rose-400"
                                disabled={undoMutation.isPending}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (window.confirm(`Undo payment for ${bill.partyName}${bill.invoiceNumber ? ` (${bill.invoiceNumber})` : ''}? This deletes the payment and its ledger entry.`)) {
                                    undoMutation.mutate(bill.deletablePaymentIds);
                                  }
                                }}
                              >
                                <Undo2 className="h-3.5 w-3.5 mr-1" /> Undo
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                      {expandedId === bill.id && (
                        <TableRow className="bg-muted/20">
                          <TableCell colSpan={10} className="p-0 border-b-0">
                            <div className="px-10 py-4">
                              <h4 className="font-semibold text-sm mb-3">Allocated Payments</h4>
                              {bill.appliedPayments.length > 0 ? (
                                <Table className="bg-background border rounded-md shadow-sm w-full max-w-2xl">
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead className="w-[150px]">Date</TableHead>
                                      <TableHead>Amount Paid</TableHead>
                                      <TableHead>Mode of Payment</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {bill.appliedPayments.map((ap, idx) => (
                                      <TableRow key={idx}>
                                        <TableCell>{shortDate(new Date(ap.date).toISOString())}</TableCell>
                                        <TableCell className="font-medium text-emerald-600">{rupees(ap.amount)}</TableCell>
                                        <TableCell>{ap.mode}</TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              ) : (
                                <p className="text-sm text-muted-foreground">No payments have been allocated to this purchase yet.</p>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {/* Pay dialog */}
      <Dialog open={!!payDialog} onOpenChange={(open) => { if (!open) setPayDialog(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Record Payment</DialogTitle>
          </DialogHeader>
          {payDialog && (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">
                {payDialog.bill.partyName} · {payDialog.bill.invoiceNumber ?? 'No invoice'}
              </p>
              <div className="space-y-1">
                <Label htmlFor="pay-date">Payment Date</Label>
                <Input
                  id="pay-date"
                  type="date"
                  value={payDialog.date}
                  onChange={(e) => setPayDialog((d) => d && ({ ...d, date: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pay-amount">Amount Paid (₹)</Label>
                <Input
                  id="pay-amount"
                  type="number"
                  step="0.01"
                  value={payDialog.amount}
                  onChange={(e) => setPayDialog((d) => d && ({ ...d, amount: e.target.value }))}
                />
                <p className="text-xs text-muted-foreground">Outstanding: {rupees(payDialog.bill.amount)}</p>
              </div>
              <div className="space-y-1">
                <Label>Mode of Payment</Label>
                <Select value={payDialog.mode} onValueChange={(val) => setPayDialog((d) => d && ({ ...d, mode: val }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select mode" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="RTGS">RTGS</SelectItem>
                    <SelectItem value="NEFT">NEFT</SelectItem>
                    <SelectItem value="IMPS">IMPS</SelectItem>
                    <SelectItem value="UPI">UPI</SelectItem>
                    <SelectItem value="Cheque">Cheque</SelectItem>
                    <SelectItem value="Cash">Cash</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayDialog(null)}>Cancel</Button>
            <Button onClick={submitPay} disabled={payMutation.isPending}>
              {payMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm Payment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
